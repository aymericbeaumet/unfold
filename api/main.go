package main

import (
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
	"github.com/mmcloughlin/geohash"
)

var httpClient = http.Client{
	Timeout: 30 * time.Second,
}

func main() {
	backgroundIndex, featuresIndex := loadData("./data")

	svc := gin.Default()
	svc.Use(cors.Default())

	svc.GET("/background", func(c *gin.Context) {
		fc := backgroundIndex.Find()
		c.JSON(http.StatusOK, fc)
	})

	svc.GET("/features", func(c *gin.Context) {
		bbox := parseBbox(c.Query("bbox"))
		lim := parseInt(c.DefaultQuery("lim", "100"))
		fc := featuresIndex.Find(bbox, lim)
		c.JSON(http.StatusOK, fc)
	})

	port := os.Getenv("PORT")
	if len(port) == 0 {
		port = "8080"
	}
	if err := svc.Run("0.0.0.0:" + port); err != nil {
		panic(err)
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
