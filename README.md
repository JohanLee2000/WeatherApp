# Skycast

A weather app you install on your phone's home screen. It has no ads, needs no account and uses no API keys.

- **Today**: current temperature, feels-like, high and low, a plain-English summary ("Rain likely from 2 PM to 6 PM (up to 70%)"), a heads-up when rain is about to start or stop, and US weather alerts from the National Weather Service.
- **Next 24 hours** (on the Today screen): temperature curve, rain chance, humidity and wind for each hour.
- **Hourly tab**: pick any of the next 10 days. It has a chart of temperature, feels-like and rain chance, plus a full table for every hour: conditions, temperature, feels-like, rain chance, rain or snow amount, humidity, dew point, wind with direction, gusts, UV, cloud cover, visibility and pressure.
- **10-Day tab**: each day's high and low, rain chance and amount, wind, UV, sunrise and sunset, a summary, and a 3-hour strip.
- **Radar tab**: one timeline that plays the last hour of real radar, then **forecast radar up to ~18 hours ahead** (continental US, from NOAA's HRRR model via Iowa State's IEM). Outside the US it shows the last 2 hours of radar from RainViewer. There are also forecast maps for **rain chance**, **rain amount** and **temperature** that you can play through the next 48 hours.
- **Right now** tiles: humidity and dew point, wind and gusts, UV, air quality (AQI), sun times, pressure trend, visibility and cloud cover.
- GPS location, city or US ZIP search, saved places, °F/°C, mph/km/h, 12- or 24-hour clock, and a dark mode that follows your phone's setting.
- It opens instantly and shows the last forecast when you're offline.

Data sources: [Open-Meteo](https://open-meteo.com/) (forecast and air quality), [RainViewer](https://www.rainviewer.com/) (radar), [NWS](https://www.weather.gov/) (US alerts), Esri (map tiles).

## Put it on your Samsung phone

The app is just static files, so it needs to be hosted somewhere with **https**. Your phone won't give a plain http page your GPS location or let you install it as an app. Hosting on GitHub Pages is free and takes about 5 minutes with GitHub Desktop:

1. App is live at `https://johanlee2000.github.io/WeatherApp/`.
2. On your phone, open that link in **Chrome** or **Samsung Internet**. When it asks for your location, allow it.
3. Install it:
   - **Chrome**: tap ⋮ and choose **Add to Home screen**, then **Install**.
   - **Samsung Internet**: tap ≡ and choose **Add page to**, then **Home screen**.

   Skycast now opens full-screen from its own icon, like any other app.

When you change the code later, commit and push in GitHub Desktop. The phone picks up the new version the next time you open the app.

## Try it on this PC

```bash
python -m http.server 8321
```

Then open http://localhost:8321.
