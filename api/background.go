package main

import (
	"math"
	"regexp"
	"strings"
	"sync"

	changecase "github.com/ku/go-change-case"
	"github.com/paulmach/orb"
	"github.com/paulmach/orb/geojson"
)

type BackgroundIndex struct {
	mu         sync.Mutex
	collection geojson.FeatureCollection
}

func NewBackgroundIndex() *BackgroundIndex {
	return &BackgroundIndex{
		collection: geojson.FeatureCollection{},
	}
}

func (index *BackgroundIndex) AddGeoJSON(raw []byte, featureClass string) error {
	fc, err := geojson.UnmarshalFeatureCollection(raw)
	if err != nil {
		return err
	}

	for _, feature := range fc.Features {
		// Overwrite properties
		properties := map[string]interface{}{
			"featureClass": featureClass,
		}
		if name, ok := feature.Properties["name"]; ok {
			if name, ok := name.(string); ok {
				if name := normalize(name); len(name) > 0 {
					properties["name"] = name
				}
			}
		}
		feature.Properties = properties

		// Trim precision
		switch g := feature.Geometry.(type) {
		case orb.LineString:
			trimLineString(g)
		case orb.Polygon:
			trimPolygon(g)
		case orb.MultiLineString:
			for i := 0; i < len(g); i++ {
				trimLineString(g[i])
			}
		case orb.MultiPolygon:
			for i := 0; i < len(g); i++ {
				trimPolygon(g[i])
			}
		}
	}

	index.mu.Lock()
	defer index.mu.Unlock()
	index.collection.Features = append(index.collection.Features, fc.Features...)

	return nil
}

func (index *BackgroundIndex) Find() *geojson.FeatureCollection {
	return &index.collection
}

var spaces = regexp.MustCompile(`\s+`)

func normalize(s string) string {
	s = strings.TrimSpace(s)
	s = spaces.ReplaceAllLiteralString(s, " ")
	return changecase.Title(s)
}

// precision / trimming

const PRECISION = 3 // decimals

var p = math.Pow(10, PRECISION)

func trimFloat64(v float64) float64 {
	return math.Round(v*p) / p
}

func trimLineString(ls orb.LineString) {
	for l := 0; l < len(ls); l++ {
		for i := 0; i < len(ls[l]); i++ {
			ls[l][i] = trimFloat64(ls[l][i])
		}
	}
}

func trimPolygon(p orb.Polygon) {
	for i := 0; i < len(p); i++ {
		trimLineString(orb.LineString(p[i]))
	}
}
