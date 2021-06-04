package main

type City struct {
	name       string
	population int
	lon, lat   float64
}

func NewCity(name string, population int, lon, lat float64) *City {
	return &City{
		name:       name,
		population: population,
		lon:        lon,
		lat:        lat,
	}
}

func (c *City) Coordinates() (float64, float64) {
	return c.lon, c.lat
}

func (c *City) Score() int {
	return c.population
}
