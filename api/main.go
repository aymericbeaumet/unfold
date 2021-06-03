package main

import (
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

var httpClient = http.Client{
	Timeout: 30 * time.Second,
}

func main() {
	data := prepareData("./data/")
	log.Println("Initialization done")

	r := gin.Default()

	r.GET("/data/land.geojson", func(c *gin.Context) {
		c.Data(http.StatusOK, "application/json", data.Land)
	})

	if err := r.Run(":9090"); err != nil {
		log.Fatalln(err)
	}
}

type Data struct {
	Cities []byte
	Land   []byte
}

func prepareData(dataDir string) Data {
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

	cities, err := os.ReadFile(filepath.Join(dataDir, "cities500.zip"))
	if err != nil {
		log.Fatalln(err)
	}

	land, err := os.ReadFile(filepath.Join(dataDir, "ne_50m_land.geojson"))
	if err != nil {
		log.Fatalln(err)
	}

	return Data{
		Cities: cities,
		Land:   land,
	}
}
