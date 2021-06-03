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
	data := download("./data/")
	log.Println("Initialization done")

	r := gin.Default()

	r.GET("/data/land.geojson", func(c *gin.Context) {
		c.Data(http.StatusOK, "application/json", data["land.geojson"])
	})

	if err := r.Run(":9090"); err != nil {
		log.Fatalln(err)
	}
}

func download(dataDir string) map[string][]byte {
	in := map[string]string{
		"cities.zip":   "https://download.geonames.org/export/dump/cities500.zip",
		"land.geojson": "https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_50m_land.geojson",
	}
	out := make(map[string][]byte, len(in))

	var wg sync.WaitGroup
	for name, url := range in {
		wg.Add(1)
		go func(name, url string) {
			defer wg.Done()

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
		}(name, url)
	}
	wg.Wait()

	for name := range in {
		bytes, err := os.ReadFile(filepath.Join(dataDir, name))
		if err != nil {
			log.Fatalln(err)
		}
		out[name] = bytes
	}

	return out
}
