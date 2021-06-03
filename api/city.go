package main

type City struct {
	name     string
	lon, lat float64
}

func NewCity(name string, lon, lat float64) *City {
	return &City{name: name, lon: lon, lat: lat}
}

func (c *City) Coordinates() (float64, float64) {
	return c.lon, c.lat
}
