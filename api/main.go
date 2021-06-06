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

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
	geojson "github.com/paulmach/go.geojson"
)

var httpClient = http.Client{
	Timeout: 30 * time.Second,
}

func main() {
	data := loadData("./data/")

	router := gin.Default()

	router.Use(cors.Default())

	router.GET("/data/cities", func(c *gin.Context) {
		bbox := c.Query("bbox")
		if len(bbox) == 0 {
			c.AbortWithStatus(http.StatusBadRequest)
			return
		}

		fc := geojson.NewFeatureCollection()

		cities := data.CitiesIndex.FindInBox(parseBbox(bbox))
		for _, city := range cities {
			lon, lat := city.Coordinates()
			f := geojson.NewPointFeature([]float64{lon, lat})
			for k, v := range city.Properties() {
				f.Properties[k] = v
			}
			fc.AddFeature(f)
		}

		c.JSON(http.StatusOK, fc)
	})

	router.GET("/data/glaciers", func(c *gin.Context) {
		c.Data(http.StatusOK, "application/json", data.GlaciersGEOJSON)
	})

	router.GET("/data/lakes", func(c *gin.Context) {
		c.Data(http.StatusOK, "application/json", data.LakesGEOJSON)
	})

	router.GET("/data/lands", func(c *gin.Context) {
		c.Data(http.StatusOK, "application/json", data.LandsGEOJSON)
	})

	router.GET("/data/marinepits", func(c *gin.Context) {
		c.Data(http.StatusOK, "application/json", data.MarinePitsGEOJSON)
	})

	router.GET("/data/rivers", func(c *gin.Context) {
		c.Data(http.StatusOK, "application/json", data.RiversGEOJSON)
	})

	if err := router.Run(":9999"); err != nil {
		log.Fatalln(err)
	}
}

type Data struct {
	CitiesIndex       *Index
	GlaciersGEOJSON   []byte
	LandsGEOJSON      []byte
	LakesGEOJSON      []byte
	MarinePitsGEOJSON []byte
	RiversGEOJSON     []byte
}

func loadData(dataDir string) Data {
	var wg sync.WaitGroup
	for _, url := range []string{
		"https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_10m_bathymetry_E_6000.geojson",
		"https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_10m_lakes.geojson",
		"https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_50m_glaciated_areas.geojson",
		"https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_50m_land.geojson",
		"https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_50m_rivers_lake_centerlines_scale_rank.geojson",
		"https://download.geonames.org/export/dump/cities500.zip",
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
			defer f.Close()

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

	citiesIndex := NewIndex()
	defer citiesIndex.Finalize()

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
			citiesIndex.Insert(NewCity(
				records[2],             // name
				records[7],             // feature code (capital, district capital, etc)
				parseInt(records[14]),  // population
				parseFloat(records[5]), // longitude
				parseFloat(records[4]), // latitude
			))
		}

		if err := scanner.Err(); err != nil {
			log.Fatalln(err)
		}
	}

	// glaciers
	glaciers, err := os.ReadFile(filepath.Join(dataDir, "ne_50m_glaciated_areas.geojson"))
	if err != nil {
		log.Fatalln(err)
	}

	// lakes
	lakes, err := os.ReadFile(filepath.Join(dataDir, "ne_10m_lakes.geojson"))
	if err != nil {
		log.Fatalln(err)
	}

	// lands
	lands, err := os.ReadFile(filepath.Join(dataDir, "ne_50m_land.geojson"))
	if err != nil {
		log.Fatalln(err)
	}

	// marine pits
	marinepits, err := os.ReadFile(filepath.Join(dataDir, "ne_10m_bathymetry_E_6000.geojson"))
	if err != nil {
		log.Fatalln(err)
	}

	// rivers
	rivers, err := os.ReadFile(filepath.Join(dataDir, "ne_50m_rivers_lake_centerlines_scale_rank.geojson"))
	if err != nil {
		log.Fatalln(err)
	}

	return Data{
		CitiesIndex:       citiesIndex,
		GlaciersGEOJSON:   glaciers,
		LakesGEOJSON:      lakes,
		LandsGEOJSON:      lands,
		MarinePitsGEOJSON: marinepits,
		RiversGEOJSON:     rivers,
	}
}

func parseFloat(s string) float64 {
	n, err := strconv.ParseFloat(s, 64)
	if err != nil {
		panic(err)
	}
	return n
}

func parseInt(s string) int {
	n, err := strconv.ParseInt(s, 10, 32)
	if err != nil {
		panic(err)
	}
	return int(n)
}

func parseBbox(s string) (float64, float64, float64, float64) {
	split := strings.Split(s, ",")
	minLon := parseFloat(split[0])
	minLat := parseFloat(split[1])
	maxLon := parseFloat(split[2])
	maxLat := parseFloat(split[3])
	return minLon, minLat, maxLon, maxLat
}
