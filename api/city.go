package main

type City struct {
	name        string
	featureCode string // http://www.geonames.org/export/codes.html
	population  int
	lon, lat    float64
}

func NewCity(name, featureCode string, population int, lon, lat float64) *City {
	return &City{
		name:        name,
		featureCode: featureCode,
		population:  population,
		lon:         lon,
		lat:         lat,
	}
}

func (c *City) IsCapital() bool {
	return c.featureCode == "PPLC"
}

func (c *City) IsDistrictCapital() bool {
	return c.featureCode == "PPLA"
}

func (c *City) Coordinates() (float64, float64) {
	return c.lon, c.lat
}

func (c *City) Score() int {
	// if the city is a capital, give it a 1B population bonus
	if c.IsCapital() {
		return 1_000_000_000 + c.population
	}
	// if the city is a district capital, give it a 100M population bonus
	if c.IsDistrictCapital() {
		return 100_000_000 + c.population
	}
	return c.population
}
