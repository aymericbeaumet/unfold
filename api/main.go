package main

import (
	"archive/zip"
	"bufio"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

var httpClient = http.Client{
	Timeout: 30 * time.Second,
}

func main() {
	data := loadData("./data/")

	r := gin.Default()

	r.GET("/data/cities", func(c *gin.Context) {
		c.JSON(http.StatusOK, data.Cities)
	})

	r.GET("/data/lands", func(c *gin.Context) {
		c.Data(http.StatusOK, "application/json", data.LandsJSON)
	})

	if err := r.Run(":9090"); err != nil {
		log.Fatalln(err)
	}
}

type Data struct {
	Cities    Cities
	LandsJSON []byte
}

type Cities struct {
	Type     string         `json:"type"`
	Features []*CityFeature `json:"features"`
}

type CityFeature struct {
	Type       string              `json:"type"`
	Geometry   CityFeatureGeometry `json:"geometry"`
	Properties map[string]string   `json:"properties"`
}

type CityFeatureGeometry struct {
	Type        string    `json:"type"`
	Coordinates []float64 `json:"coordinates"`
}

func loadData(dataDir string) Data {
	var wg sync.WaitGroup
	for _, url := range []string{
		"https://download.geonames.org/export/dump/cities500.zip",
		"https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_50m_land.geojson",
	} {
		wg.Add(1)
		go func(url string) {
			defer wg.Done()

			name := filepath.Base(url)

			path := filepath.Join(dataDir, name)
			if _, err := os.Stat(path); err == nil {
				log.Println("Skipping", path)
				return
			}
			log.Println("Downloading", path)

			if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
				log.Fatalln(name, err)
			}

			f, err := os.Create(path)
			if err != nil {
				log.Fatalln(name, err)
			}

			resp, err := httpClient.Get(url)
			if err != nil {
				log.Fatalln(name, err)
			}
			defer resp.Body.Close()

			if resp.StatusCode != http.StatusOK {
				log.Fatalln(name, "unexpected status code", resp.Status)
			}

			if _, err := io.Copy(f, resp.Body); err != nil {
				log.Fatalln(err)
			}
		}(url)
	}
	wg.Wait()

	// cities

	cities := Cities{
		Type: "FeatureCollection",
	}

	citiesZip, err := zip.OpenReader(filepath.Join(dataDir, "cities500.zip"))
	if err != nil {
		log.Fatalln(err)
	}
	defer citiesZip.Close()

	for _, file := range citiesZip.File {
		if file.Name != "cities500.txt" {
			log.Fatalln("unexpected file in archive")
		}

		f, err := file.Open()
		if err != nil {
			log.Fatalln(err)
		}
		defer f.Close()

		scanner := bufio.NewScanner(f)
		for scanner.Scan() {
			records := strings.Split(scanner.Text(), "\t")
			cities.Features = append(cities.Features, &CityFeature{
				Type: "Feature",
				Geometry: CityFeatureGeometry{
					Type:        "Point",
					Coordinates: []float64{MustParseFloat(records[5]), MustParseFloat(records[4])},
				},
				Properties: map[string]string{
					"Name": records[2],
				},
			})
		}

		if err := scanner.Err(); err != nil {
			log.Fatalln(err)
		}
	}

	// lands

	lands, err := os.ReadFile(filepath.Join(dataDir, "ne_50m_land.geojson"))
	if err != nil {
		log.Fatalln(err)
	}

	return Data{
		Cities:    cities,
		LandsJSON: lands,
	}
}

func MustParseFloat(s string) float64 {
	n, err := strconv.ParseFloat(s, 64)
	if err != nil {
		panic(err)
	}
	return n
}
