package main

import (
	"sort"

	"github.com/mmcloughlin/geohash"
)

type Index struct {
	limit     int
	byGeohash map[uint64][]Indexable
}

type Indexable interface {
	Coordinates() (lon float64, lat float64)
	Properties() map[string]interface{}
	Score() int
}

func NewIndex() *Index {
	return &Index{
		limit:     100,
		byGeohash: map[uint64][]Indexable{},
	}
}

func (index *Index) Insert(f Indexable) {
	lon, lat := f.Coordinates()
	hash := geohash.EncodeIntWithPrecision(lat, lon, 10)
	index.byGeohash[hash] = append(index.byGeohash[hash], f)

	for _, nhash := range geohash.NeighborsIntWithPrecision(hash, 10) {
		index.byGeohash[nhash] = append(index.byGeohash[nhash], f)
	}
}

func (index *Index) Find(lon, lat float64) []Indexable {
	hash := geohash.EncodeIntWithPrecision(lat, lon, 10)
	return index.byGeohash[hash]
}

func (index *Index) FindInBox(minLon, minLat, maxLon, maxLat float64) []Indexable {
	b := geohash.Box{
		MinLng: minLon,
		MinLat: minLat,
		MaxLng: maxLon,
		MaxLat: maxLat,
	}
	lat, lon := b.Center()
	return index.Find(lon, lat)
}

func (index *Index) Finalize() {
	for i, slice := range index.byGeohash {
		if len(slice) > index.limit {
			sort.Slice(slice, func(a, b int) bool {
				return slice[a].Score() > slice[b].Score()
			})
			index.byGeohash[i] = index.byGeohash[i][:index.limit]
		}
	}
}
