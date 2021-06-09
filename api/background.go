package main

import (
	"github.com/paulmach/orb/geojson"
)

type BackgroundIndex struct {
	collection geojson.FeatureCollection
}

func NewBackgroundIndex() *BackgroundIndex {
	return &BackgroundIndex{
		collection: geojson.FeatureCollection{},
	}
}

func (index *BackgroundIndex) AddGeoJSON(raw []byte, featureClass string) {
	fc, err := geojson.UnmarshalFeatureCollection(raw)
	if err != nil {
		panic(err)
	}

	for _, feature := range fc.Features {
		delete(feature.Properties, "featureclass")
		feature.Properties["featureClass"] = featureClass

		index.collection.Append(feature)
	}
}

func (index *BackgroundIndex) Find() *geojson.FeatureCollection {
	return &index.collection
}
