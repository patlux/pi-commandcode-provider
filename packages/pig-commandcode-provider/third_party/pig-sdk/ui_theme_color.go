// SPDX-FileCopyrightText: Copyright Hewlett Packard Enterprise Development LP
// SPDX-License-Identifier: MIT

package sdk

import (
	"math"
	"strconv"
)

// The color conversions below port the part of pi-tui's colors.ts and oklab.ts that renders a Color as an SGR sequence (.upstream/v0.99.2/packages/tui/src/colors.ts foregroundAnsi, backgroundAnsi, styleTextWithAnsi; oklab.ts oklabToLinearSrgb). Oklab is Björn Ottosson's color space (https://bottosson.github.io/posts/colorpicker/, MIT).

type rgbChannels struct{ r, g, b float64 }

var (
	labToLMS = [3][3]float64{
		{1, 0.3963377773761749, 0.2158037573099136},
		{1, -0.1055613458156586, -0.0638541728258133},
		{1, -0.0894841775298119, -1.2914855480194092},
	}
	lmsToLinearSrgb = [3][3]float64{
		{4.0767416360759583, -3.3077115392580629, 0.2309699031821043},
		{-1.2684379732850315, 2.6097573492876882, -0.341319376002657},
		{-0.0041960761386756, -0.7034186179359362, 1.7076146940746117},
	}
	basicColors = [16]rgbChannels{
		{0, 0, 0}, {128, 0, 0}, {0, 128, 0}, {128, 128, 0}, {0, 0, 128}, {128, 0, 128}, {0, 128, 128}, {192, 192, 192},
		{128, 128, 128}, {255, 0, 0}, {0, 255, 0}, {255, 255, 0}, {0, 0, 255}, {255, 0, 255}, {0, 255, 255}, {255, 255, 255},
	}
	colorCubeValues = [6]float64{0, 95, 135, 175, 215, 255}
)

// jsRound is JavaScript's Math.round: halves round toward positive infinity.
func jsRound(value float64) float64 { return math.Floor(value + 0.5) }

func linearToSrgb(value float64) float64 {
	if value > 0.0031308 {
		return 1.055*math.Pow(value, 1/2.4) - 0.055
	}
	return 12.92 * value
}

func oklabToLinearSrgb(l, a, b float64) [3]float64 {
	var cubed [3]float64
	for i, row := range labToLMS {
		lms := row[0]*l + row[1]*a + row[2]*b
		cubed[i] = lms * lms * lms
	}
	var out [3]float64
	for i, row := range lmsToLinearSrgb {
		out[i] = row[0]*cubed[0] + row[1]*cubed[1] + row[2]*cubed[2]
	}
	return out
}

func isInSrgbGamut(linear [3]float64) bool {
	const epsilon = 1e-7
	for _, channel := range linear {
		if !(channel >= -epsilon && channel <= 1+epsilon) {
			return false
		}
	}
	return true
}

func linearSrgbToRgb(linear [3]float64) rgbChannels {
	channel := func(value float64) float64 {
		return jsRound(math.Min(1, math.Max(0, linearToSrgb(value))) * 255)
	}
	return rgbChannels{channel(linear[0]), channel(linear[1]), channel(linear[2])}
}

// oklchToRgb maps an OKLCH color into sRGB, keeping its hue and reducing chroma until it fits the gamut (the achromatic color is the fallback, so oklch(100% 0.3 150) is white).
func oklchToRgb(c OklchColorValue) rgbChannels {
	radians := (c.H * math.Pi) / 180
	cos, sin := math.Cos(radians), math.Sin(radians)
	atChroma := func(chroma float64) [3]float64 { return oklabToLinearSrgb(c.L, chroma*cos, chroma*sin) }

	if direct := atChroma(c.C); isInSrgbGamut(direct) {
		return linearSrgbToRgb(direct)
	}
	linear := atChroma(0)
	low, high := 0.0, c.C
	for range 20 {
		chroma := (low + high) / 2
		if candidate := atChroma(chroma); isInSrgbGamut(candidate) {
			low = chroma
			linear = candidate
		} else {
			high = chroma
		}
	}
	return linearSrgbToRgb(linear)
}

func indexedToRgb(index int) rgbChannels {
	if index < 16 {
		return basicColors[max(index, 0)]
	}
	if index < 232 {
		cube := index - 16
		return rgbChannels{colorCubeValues[cube/36], colorCubeValues[(cube%36)/6], colorCubeValues[cube%6]}
	}
	gray := float64(8 + (index-232)*10)
	return rgbChannels{gray, gray, gray}
}

func colorToRgb(color Color) rgbChannels {
	switch color := color.(type) {
	case IndexedColor:
		return indexedToRgb(color.Index)
	case RgbColorValue:
		return rgbChannels{color.R, color.G, color.B}
	case OklchColorValue:
		return oklchToRgb(color)
	}
	return rgbChannels{}
}

func findClosest(values []float64, target float64) int {
	closest, distance := 0, math.Inf(1)
	for index, value := range values {
		if d := math.Abs(target - value); d < distance {
			closest, distance = index, d
		}
	}
	return closest
}

func colorDistance(first, second rgbChannels) float64 {
	dr, dg, db := first.r-second.r, first.g-second.g, first.b-second.b
	return dr*dr*0.299 + dg*dg*0.587 + db*db*0.114
}

func rgbToAnsi256(color rgbChannels) int {
	rIndex := findClosest(colorCubeValues[:], color.r)
	gIndex := findClosest(colorCubeValues[:], color.g)
	bIndex := findClosest(colorCubeValues[:], color.b)
	cubeColor := rgbChannels{colorCubeValues[rIndex], colorCubeValues[gIndex], colorCubeValues[bIndex]}
	cubeIndex := 16 + 36*rIndex + 6*gIndex + bIndex

	grays := make([]float64, 24)
	for i := range grays {
		grays[i] = float64(8 + i*10)
	}
	gray := jsRound(0.299*color.r + 0.587*color.g + 0.114*color.b)
	grayOffset := findClosest(grays, gray)
	grayValue := grays[grayOffset]
	spread := math.Max(color.r, math.Max(color.g, color.b)) - math.Min(color.r, math.Min(color.g, color.b))
	if spread < 10 && colorDistance(color, rgbChannels{grayValue, grayValue, grayValue}) < colorDistance(color, cubeColor) {
		return 232 + grayOffset
	}
	return cubeIndex
}

// colorAnsi is the SGR sequence selecting color as the foreground or background in the given color mode.
func colorAnsi(color Color, mode string, background bool) string {
	layer := "38"
	if background {
		layer = "48"
	}
	if indexed, ok := color.(IndexedColor); ok {
		return "\x1b[" + layer + ";5;" + strconv.Itoa(indexed.Index) + "m"
	}
	rgb := colorToRgb(color)
	if mode == "truecolor" {
		return "\x1b[" + layer + ";2;" + formatChannel(jsRound(rgb.r)) + ";" + formatChannel(jsRound(rgb.g)) + ";" + formatChannel(jsRound(rgb.b)) + "m"
	}
	return "\x1b[" + layer + ";5;" + strconv.Itoa(rgbToAnsi256(rgb)) + "m"
}

func formatChannel(value float64) string { return strconv.FormatFloat(value, 'f', -1, 64) }

// styleTextWithAnsi wraps text in the given color sequences and attributes, closing them in reverse order of opening (pi-tui styleTextWithAnsi). An empty sequence is unset.
func styleTextWithAnsi(text, fgAnsi, bgAnsi string, attributes TextAttributes) string {
	prefix, suffix := "", ""
	if fgAnsi != "" {
		prefix += fgAnsi
		suffix = "\x1b[39m"
	}
	if bgAnsi != "" {
		prefix += bgAnsi
		suffix = "\x1b[49m" + suffix
	}
	if attributes.Bold {
		prefix += "\x1b[1m"
	}
	if attributes.Dim {
		prefix += "\x1b[2m"
	}
	if attributes.Bold || attributes.Dim {
		suffix = "\x1b[22m" + suffix
	}
	if attributes.Italic {
		prefix += "\x1b[3m"
		suffix = "\x1b[23m" + suffix
	}
	if attributes.Underline {
		prefix += "\x1b[4m"
		suffix = "\x1b[24m" + suffix
	}
	if attributes.Inverse {
		prefix += "\x1b[7m"
		suffix = "\x1b[27m" + suffix
	}
	if attributes.Strikethrough {
		prefix += "\x1b[9m"
		suffix = "\x1b[29m" + suffix
	}
	return prefix + text + suffix
}
