package main

import (
	"github.com/paulmach/orb/geojson"
	"github.com/paulmach/orb/simplify"
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
	s := simplify.DouglasPeucker(0.0001)

	fc, err := geojson.UnmarshalFeatureCollection(raw)
	if err != nil {
		panic(err)
	}

	for _, feature := range fc.Features {
		feature.Geometry = s.Simplify(feature.Geometry)

		delete(feature.Properties, "featureclass")
		feature.Properties["featureClass"] = featureClass

		index.collection.Append(feature)
	}
}

func (index *BackgroundIndex) Find() *geojson.FeatureCollection {
	return &index.collection
}
