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

type Index struct {
	minPrecisionBits uint
	maxPrecisionBits uint

	maxResults int

	featuresByGeohash map[uint64][]Feature
}

func NewIndex(minPrecisionBits, maxPrecisionBits uint) *Index {
	return &Index{
		minPrecisionBits: minPrecisionBits,
		maxPrecisionBits: maxPrecisionBits,

		maxResults: 100,

		featuresByGeohash: map[uint64][]Feature{},
	}
}

func (index *Index) InsertPoint(f Feature) {
	lon, lat := f.Coordinates()
	hash := geohash.EncodeInt(lat, lon)
	for bits := index.minPrecisionBits; bits <= index.maxPrecisionBits; bits++ {
		h := hash >> (64 - bits)
		index.featuresByGeohash[h] = append(index.featuresByGeohash[h], f)
	}
}

func (index *Index) Finalize() {
	for ghash, features := range index.featuresByGeohash {
		sortFeatures(features)
		if len(features) > index.maxResults {
			index.featuresByGeohash[ghash] = index.featuresByGeohash[ghash][:index.maxResults]
		}
	}
}

func (index *Index) Find(bbox geohash.Box, lim int) []Feature {
	hash := geohash.EncodeInt(bbox.Center())

	for bits := index.maxPrecisionBits; bits >= index.minPrecisionBits; bits-- {
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

		return index.find(bbox, lim, h, bits)
	}

	return nil
}

func (index *Index) find(bbox geohash.Box, lim int, hash uint64, bits uint) []Feature {
	if lim > index.maxResults {
		lim = index.maxResults
	}

	var out []Feature
	for _, h := range append([]uint64{hash}, geohash.NeighborsIntWithPrecision(hash, bits)...) {
		for _, f := range index.featuresByGeohash[h] {
			lon, lat := f.Coordinates()
			if bbox.Contains(lat, lon) {
				out = append(out, f)
			}
		}
	}

	sortFeatures(out)
	if len(out) > lim {
		out = out[:lim]
	}

	return out
}

func sortFeatures(slice []Feature) {
	sort.Slice(slice, func(a, b int) bool {
		return slice[a].Score() > slice[b].Score()
	})
}
