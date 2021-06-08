package main

import (
	"sort"

	"github.com/mmcloughlin/geohash"
)

type Feature interface {
	Coordinates() (lon float64, lat float64)
	Properties() map[string]interface{}
	Score() int
}

type FeaturesIndex struct {
	minPrecisionBits uint
	maxPrecisionBits uint

	maxResults int

	featuresByGeohash map[uint64][]Feature
}

func NewFeaturesIndex(minPrecisionBits, maxPrecisionBits uint) *FeaturesIndex {
	return &FeaturesIndex{
		minPrecisionBits: minPrecisionBits,
		maxPrecisionBits: maxPrecisionBits,

		maxResults: 100,

		featuresByGeohash: map[uint64][]Feature{},
	}
}

func (feature *FeaturesIndex) Add(f Feature) {
	lon, lat := f.Coordinates()
	hash := geohash.EncodeInt(lat, lon)
	for bits := feature.minPrecisionBits; bits <= feature.maxPrecisionBits; bits++ {
		h := hash >> (64 - bits)
		feature.featuresByGeohash[h] = append(feature.featuresByGeohash[h], f)
	}
}

func (feature *FeaturesIndex) Finalize() {
	for ghash, features := range feature.featuresByGeohash {
		sortFeatures(features)
		if len(features) > feature.maxResults {
			feature.featuresByGeohash[ghash] = feature.featuresByGeohash[ghash][:feature.maxResults]
		}
	}
}

func (feature *FeaturesIndex) Find(bbox geohash.Box, lim int) []Feature {
	hash := geohash.EncodeInt(bbox.Center())

	for bits := feature.maxPrecisionBits; bits >= feature.minPrecisionBits; bits-- {
		h := hash >> (64 - bits)
		neighbors := geohash.NeighborsIntWithPrecision(h, bits)

		w := geohash.BoundingBoxIntWithPrecision(neighbors[geohash.West], bits)
		if w.MinLng > bbox.MinLng {
			continue
		}

		s := geohash.BoundingBoxIntWithPrecision(neighbors[geohash.South], bits)
		if s.MinLat > bbox.MaxLat {
			continue
		}

		e := geohash.BoundingBoxIntWithPrecision(neighbors[geohash.East], bits)
		if e.MaxLng < bbox.MaxLng {
			continue
		}

		n := geohash.BoundingBoxIntWithPrecision(neighbors[geohash.North], bits)
		if n.MaxLat < bbox.MaxLat {
			continue
		}

		return feature.find(bbox, lim, h, bits)
	}

	return nil
}

func (feature *FeaturesIndex) find(bbox geohash.Box, lim int, hash uint64, bits uint) []Feature {
	if lim > feature.maxResults {
		lim = feature.maxResults
	}

	// identify which features lists should be used
	featuresByGeohash := make(map[uint64][]Feature, 1+8)
	featuresByGeohash[hash] = feature.featuresByGeohash[hash]
	for _, h := range geohash.NeighborsIntWithPrecision(hash, bits) {
		featuresByGeohash[h] = feature.featuresByGeohash[h]
	}

	// leverage the fact these lists are sorted to pick 1 by 1 until out is full,
	// or the lists are empty
	out := make([]Feature, 0, lim)
	for i := 0; len(featuresByGeohash) > 0; i++ {
		for hash, features := range featuresByGeohash {
			if i >= len(features) {
				delete(featuresByGeohash, hash)
				continue
			}
			feature := features[i]
			lon, lat := feature.Coordinates()
			if bbox.Contains(lat, lon) {
				out = append(out, feature)
				if len(out) >= lim {
					return out
				}
			}
		}
	}

	return out
}

func sortFeatures(slice []Feature) {
	sort.Slice(slice, func(a, b int) bool {
		return slice[a].Score() > slice[b].Score()
	})
}
