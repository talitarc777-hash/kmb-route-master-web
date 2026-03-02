# **KMB Route Master PWA**

An advanced Hong Kong bus navigation application built with React, Tailwind CSS, and the ArcGIS Maps SDK for JavaScript. This app utilizes official CSDI (Common Spatial Data Infrastructure) data for high-precision mapping and incorporates Google Gemini AI for smart trip insights.

## **✨ Features**

* **High-Precision Mapping**: Integration with Lands Department CSDI Vector Tile API for localized, high-resolution Hong Kong maps.  
* **Smart Trip Insights**: Uses Gemini 2.5 Flash to provide "pro-tips" for specific bus routes (e.g., scenic views, interchange advice).  
* **AI-Powered Trip Planner**: Suggests adventure destinations accessible by KMB buses based on the user's context.  
* **Real-time Locating**: Quick user positioning and station finding.  
* **Visual Route Overlays**: Detailed polyline rendering of bus paths and walking segments.

## **🛠️ Tech Stack**

* **Frontend**: React (Hooks, Functional Components)  
* **Styling**: Tailwind CSS  
* **Maps**: ArcGIS Maps SDK for JavaScript (4.29)  
* **AI**: Gemini API (Google Generative AI)  
* **Icons**: Lucide-React

## **🚀 Getting Started**

1. **Clone the repository**  
   git clone \[https://github.com/your-username/kmb-route-master.git\](https://github.com/your-username/kmb-route-master.git)

2. **API Key Setup**  
   The app requires a Gemini API key. Ensure you set your key in the apiKey variable within the App component or environment variables.  
3. **Run the App**  
   Open the index.html file in a browser or serve the project using a local development server like Vite or Live Server.

## **⚖️ Disclaimer**

Map data is provided by the Lands Department of the Government of the Hong Kong Special Administrative Region. All bus route information and branding are property of The Kowloon Motor Bus Co. (1933) Ltd (KMB).