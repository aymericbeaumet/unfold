package main

import "github.com/mmcloughlin/geohash"

type Index struct {
	index     map[uint64][]Indexable
	precision uint
}

type Indexable interface {
	Coordinates() (lon float64, lat float64)
}

func NewIndex() *Index {
	return &Index{
		index:     map[uint64][]Indexable{},
		precision: 4, // 20km
	}
}

func (i *Index) Insert(f Indexable) {
	lon, lat := f.Coordinates()
	h := geohash.EncodeIntWithPrecision(lat, lon, i.precision)
	i.index[h] = append(i.index[h], f)
}

func (i *Index) Find(lon, lat float64) []Indexable {
	h := geohash.EncodeIntWithPrecision(lat, lon, i.precision)
	return i.index[h]
}

func (i *Index) FindInBox(minLon, maxLon, minLat, maxLat float64) []Indexable {
	return i.Find(minLon, minLat)
}
