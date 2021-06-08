package main

import (
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
	"github.com/mmcloughlin/geohash"
	geojson "github.com/paulmach/go.geojson"
)

var httpClient = http.Client{
	Timeout: 30 * time.Second,
}

func main() {
	index := loadData("./data")

	router := gin.Default()
	router.Use(cors.Default())

	router.GET("/data", func(c *gin.Context) {
		bbox := parseBbox(c.Query("bbox"))
		lim := parseInt(c.DefaultQuery("lim", "100"))

		fc := geojson.NewFeatureCollection()
		for _, feature := range index.Find(bbox, lim) {
			lon, lat := feature.Coordinates()
			f := geojson.NewPointFeature([]float64{lon, lat})
			for k, v := range feature.Properties() {
				f.Properties[k] = v
			}
			fc.AddFeature(f)
		}

		c.JSON(http.StatusOK, fc)
	})

	if err := router.Run(":9999"); err != nil {
		log.Fatalln(err)
	}
}

func parseBbox(s string) geohash.Box {
	split := strings.Split(s, ",")
	return geohash.Box{
		MinLng: parseFloat(split[0]),
		MinLat: parseFloat(split[1]),
		MaxLng: parseFloat(split[2]),
		MaxLat: parseFloat(split[3]),
	}
}

func parseFloat(s string) float64 {
	n, err := strconv.ParseFloat(s, 64)
	if err != nil {
		panic(err)
	}
	return n
}

func parseInt(s string) int {
	n, err := strconv.ParseInt(s, 10, 32)
	if err != nil {
		panic(err)
	}
	return int(n)
}
