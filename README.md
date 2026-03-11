# **KMB Route Master PWA**

An advanced Hong Kong bus navigation application built with React, Tailwind CSS, and the ArcGIS Maps SDK for JavaScript. This app utilizes official CSDI (Common Spatial Data Infrastructure) data for high-precision mapping and incorporates Google Gemini AI for smart trip insights.

## **✨ Features**

* **High-Precision Mapping**: Integration with Lands Department CSDI Vector Tile API for localized, high-resolution Hong Kong maps.  
* **Smart Trip Insights**: Uses Gemini 2.5 Flash to provide "pro-tips" for specific bus routes (e.g., scenic views, interchange advice).  
* **AI-Powered Trip Planner**: Suggests adventure destinations accessible by KMB buses based on the user's context.  
* **Real-time Locating**: Quick user positioning and station finding.  
* **Visual Route Overlays**: Detailed polyline rendering of bus paths and walking segments.

## **🛠️ Tech Stack**

* **Frontend**: React (Vite)
* **Styling**: Tailwind CSS v4
* **Maps**: ArcGIS Maps SDK for JavaScript (4.29)  
* **AI**: Gemini API (Google Generative AI)  

## **🚀 Getting Started**

### **1. Clone and Install**

```bash
git clone https://github.com/your-username/kmb-route-master.git
cd kmb-route-master
npm install
```

### **2. Environment Setup**

Create a `.env` file in the root directory:

```env
VITE_GEMINI_API_KEY=your_gemini_api_key_here
```

### **3. Development**

```bash
npm run dev
```

### **4. Build for Production**

```bash
npm run build
```

The app will be built in the `dist/` directory, ready for deployment.

## **⚙️ CI/CD**

Automated deployment is configured via GitHub Actions. Pushing to the `main` branch will automatically build and deploy the app to GitHub Pages.

## **⚖️ Disclaimer**

Map data is provided by the Lands Department of the Government of the Hong Kong Special Administrative Region. All bus route information and branding are property of The Kowloon Motor Bus Co. (1933) Ltd (KMB).