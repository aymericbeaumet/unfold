package main

import (
	"fmt"

	"github.com/mmcloughlin/geohash"
	"github.com/paulmach/orb/geojson"
)

type BackgroundIndex struct {
	features map[int][]*geojson.Feature
	seq      int
}

func NewBackgroundIndex() *BackgroundIndex {
	return &BackgroundIndex{
		features: map[int][]*geojson.Feature{},
	}
}

func (index *BackgroundIndex) AddGeoJSON(raw []byte, featureClass string) {
	index.seq++

	fc, err := geojson.UnmarshalFeatureCollection(raw)
	if err != nil {
		panic(err)
	}

	for i, feature := range fc.Features {
		feature.ID = fmt.Sprintf("%d_%d", index.seq, i)

		delete(feature.Properties, "featureclass")
		feature.Properties["featureClass"] = featureClass

		bbox := feature.BBox.Bound()
		minLon, maxLon := bbox.Left(), bbox.Right()

		for i := int(minLon); i <= int(maxLon); i++ {
			index.features[i] = append(index.features[i], feature)
		}
	}
}

func (index *BackgroundIndex) Find(bbox geohash.Box) *geojson.FeatureCollection {
	out := geojson.NewFeatureCollection()
	uniq := map[string]struct{}{}

	for lon := int(bbox.MinLng); lon <= int(bbox.MaxLng); lon++ {
		for _, feature := range index.features[lon] {
			id := feature.ID.(string)
			if _, ok := uniq[id]; !ok {
				uniq[id] = struct{}{}
				out.Append(feature)
			}
		}
	}

	return out
}
