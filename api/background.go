package main

import (
	"regexp"
	"strings"
	"sync"

	changecase "github.com/ku/go-change-case"
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
