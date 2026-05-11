# **KMB Route Master PWA**

A Hong Kong bus navigation application built with React, Tailwind CSS, and the ArcGIS Maps SDK for JavaScript. This app utilizes official CSDI (Common Spatial Data Infrastructure) data for high-precision mapping and incorporates Google Gemini AI for smart trip insights.

## **✨ Features**

* **High-Precision Mapping**: Integration with Lands Department CSDI Vector Tile API for localized, high-resolution Hong Kong maps.  
* **Smart Trip Insights**: Uses Gemini 2.5 Flash to provide "pro-tips" for specific bus routes (e.g., scenic views, interchange advice). //pending 
* **AI-Powered Trip Planner**: Suggests adventure destinations accessible by KMB buses based on the user's context.  
* **Real-time Locating**: Quick user positioning and station finding.  
* **Visual Route Overlays**: Detailed polyline rendering of bus paths and walking segments.
* **iPhone & Mobile Support**: Works seamlessly on iPhone via PWA. Add to home screen for app-like experience.

## **🛠️ Tech Stack**

* **Frontend**: React 18 (Vite 6)
* **Styling**: Tailwind CSS v4
* **Maps**: ArcGIS Maps SDK for JavaScript (4.29)  
* **AI**: Gemini API (Google Generative AI)
* **PWA**: Vite PWA Plugin with offline support

## **🚀 Getting Started**

### **1. Clone and Install**

```bash
git clone https://github.com/your-username/kmb-route-master-web.git
cd kmb-route-master-web
npm install
```

### **2. Environment Setup**

Copy `.env.example` to `.env` and add your API keys:

```bash
cp .env.example .env
```

Edit `.env` with your keys:
```env
VITE_GEMINI_API_KEY=your_gemini_api_key_here
GCP_API_KEY=your_gcp_api_key_here
# Optional: set only when API is hosted on a different domain
# Leave empty when frontend and API share the same host
VITE_API_BASE_URL=
```

Get your free Gemini API key at: https://ai.google.dev/

### **3. Development**

```bash
npm run dev
```

Visit `http://localhost:5173` in your browser.

### **4. Build for Production**

```bash
npm run build
npm run preview
```

The app will be built in the `dist/` directory, ready for deployment.

## **📱 iPhone Access via GitHub Pages**

This project is configured to deploy to GitHub Pages. After pushing to GitHub:

1. Go to your repository Settings → Pages
2. Ensure "Deploy from a branch" is set to `main` branch
3. Your app will be available at: `https://your-username.github.io/kmb-route-master-web/`
4. **On iPhone**: Open in Safari → Tap Share → "Add to Home Screen"
5. The app will launch with native app-like appearance (PWA)

## **⚙️ Deployment**

Automated deployment is configured via GitHub Actions (`.github/workflows/deploy.yml`). 

When you push to the `main` branch:
1. GitHub Actions automatically builds the project
2. Builds only if all dependencies install correctly
3. Deploys to GitHub Pages

**Note:** Ensure your GitHub repository Secrets include:
- `VITE_GEMINI_API_KEY` - Required for AI features
- `GCP_API_KEY` - Optional for additional features

Set secrets in: Settings → Secrets and variables → Actions → New repository secret

## **Project Structure**

```
kmb-route-master-web/
├── public/              # Static assets (icons, CSS)
├── src/                 # React components and logic
├── .github/workflows/   # GitHub Actions CI/CD
├── vite.config.js       # Vite configuration with PWA support
├── package.json         # Dependencies and build scripts
└── index.html           # Entry HTML file
```

## **⚖️ Disclaimer**

Map data is provided by the Lands Department of the Government of the Hong Kong Special Administrative Region. All bus route information and branding are property of The Kowloon Motor Bus Co. (1933) Ltd (KMB).
