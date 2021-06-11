package main

import (
	"archive/zip"
	"bufio"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

func loadData(dataDir string) (*BackgroundIndex, *FeaturesIndex) {
	var wg sync.WaitGroup

	// background index

	backgroundIndex := NewBackgroundIndex()

	for _, source := range []struct {
		featureClass string
		url          string
	}{
		{"bathymetry_deep", "https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_10m_bathymetry_E_6000.geojson"},
		{"bathymetry_shallow", "https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_10m_bathymetry_J_1000.geojson"},
		{"glacier", "https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_50m_glaciated_areas.geojson"},
		{"lake", "https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_10m_lakes.geojson"},
		{"land", "https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_50m_land.geojson"},
		{"marine", "https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_10m_geography_marine_polys.geojson"},
		{"river", "https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_10m_rivers_europe.geojson"},
		{"river", "https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_10m_rivers_north_america.geojson"},
		{"river", "https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_50m_rivers_lake_centerlines_scale_rank.geojson"},
	} {
		wg.Add(1)
		go func(featureClass, url string) {
			defer wg.Done()

			path, err := download(dataDir, url)
			if err != nil {
				log.Fatalln(err)
			}

			raw, err := os.ReadFile(path)
			if err != nil {
				log.Fatalln(err)
			}

			if err := backgroundIndex.AddGeoJSON(raw, featureClass); err != nil {
				log.Fatalln(err)
			}
		}(source.featureClass, source.url)
	}

	// features index

	featuresIndex := NewFeaturesIndex(1, 20)

	wg.Add(1)
	go func() {
		defer wg.Done()
		defer featuresIndex.Finalize()

		path, err := download(dataDir, "https://download.geonames.org/export/dump/cities500.zip")
		if err != nil {
			log.Fatalln(err)
		}

		citiesZip, err := zip.OpenReader(path)
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
				featuresIndex.Add(NewCity(
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
	}()

	wg.Wait()

	return backgroundIndex, featuresIndex
}

func download(dataDir, url string) (string, error) {
	name := filepath.Base(url)
	path := filepath.Join(dataDir, name)

	if _, err := os.Stat(path); err == nil {
		log.Println("Skipping", path)
		return path, nil
	}
	log.Println("Downloading", path)

	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return "", err
	}

	f, err := os.Create(path)
	if err != nil {
		return "", err
	}
	defer f.Close()

	resp, err := httpClient.Get(url)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("unexpected status code %d", resp.StatusCode)
	}

	if _, err := io.Copy(f, resp.Body); err != nil {
		return "", err
	}

	return path, nil
}
