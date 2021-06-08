package main

import (
	"archive/zip"
	"bufio"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

func loadData(dataDir string) *Index {
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
			download(dataDir, url)
		}(url)
	}
	wg.Wait()

	index := NewIndex(1, 20)
	defer index.Finalize()

	// cities

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
			index.InsertPoint(NewCity(
				records[1],             // name
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

	//glaciers, err := os.ReadFile(filepath.Join(dataDir, "ne_50m_glaciated_areas.geojson"))
	//lakes, err := os.ReadFile(filepath.Join(dataDir, "ne_10m_lakes.geojson"))
	//lands, err := os.ReadFile(filepath.Join(dataDir, "ne_50m_land.geojson"))
	//marinepits, err := os.ReadFile(filepath.Join(dataDir, "ne_10m_bathymetry_E_6000.geojson"))
	//rivers, err := os.ReadFile(filepath.Join(dataDir, "ne_50m_rivers_lake_centerlines_scale_rank.geojson"))

	return index
}

func download(dataDir, url string) {
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
}
