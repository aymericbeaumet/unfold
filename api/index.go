package main

import (
	"sort"

	"github.com/mmcloughlin/geohash"
)

type Index struct {
	density   int
	byGeohash map[uint64][]Indexable
}

type Indexable interface {
	Coordinates() (lon float64, lat float64)
	Score() int
}

func NewIndex() *Index {
	return &Index{
		density:   100,
		byGeohash: map[uint64][]Indexable{},
	}
}

func (index *Index) Insert(f Indexable) {
	lon, lat := f.Coordinates()
	h := geohash.EncodeIntWithPrecision(lat, lon, 16)
	index.byGeohash[h] = append(index.byGeohash[h], f)
}

func (index *Index) Find(lon, lat float64) []Indexable {
	h := geohash.EncodeIntWithPrecision(lat, lon, 16)
	return index.byGeohash[h]
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
		if len(slice) > index.density {
			sort.Slice(slice, func(a, b int) bool {
				return slice[a].Score() > slice[b].Score()
			})
			index.byGeohash[i] = index.byGeohash[i][:index.density]
		}
	}
}
