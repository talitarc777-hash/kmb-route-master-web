# KMB Route Master - Setup & Deployment Guide

## Project Structure Overview

This project is a **React + Vite PWA** (Progressive Web App) that deploys to GitHub Pages.

```
kmb-route-master-web/
├── .github/workflows/    # GitHub Actions automation
│   └── deploy.yml        # Auto-deploy on push to main
├── public/               # Static assets
│   ├── arcgis.css       # ArcGIS Maps styling
│   ├── pwa-192x192.png  # PWA icon (small)
│   └── pwa-512x512.png  # PWA icon (large)
├── src/                  # React source code
│   ├── App.jsx          # Main app component
│   ├── main.jsx         # React entry point
│   └── App.css          # Component styles
├── index.html           # HTML entry point
├── vite.config.js       # Vite + PWA configuration
├── package.json         # Dependencies & scripts
├── .env.example         # API key template
└── README.md            # User documentation
```

## Local Development Setup

### 1. Prerequisites
- **Node.js** 18+ (download from https://nodejs.org/)
- **Git** (for version control)

### 2. Clone & Install

```bash
git clone https://github.com/your-username/kmb-route-master-web.git
cd kmb-route-master-web
npm install
```

### 3. Configure API Keys

Copy the template file and add your keys:

```bash
cp .env.example .env
```

Edit `.env`:
```env
VITE_GEMINI_API_KEY=your_key_here
GCP_API_KEY=your_key_here
```

**Get free API keys:**
- Gemini: https://ai.google.dev/
- GCP: https://cloud.google.com/docs/authentication/api-keys

### 4. Development Server

```bash
npm run dev
```

Open http://localhost:5173 in your browser. The app will auto-reload on file changes.

### 5. Build for Production

```bash
npm run build
```

Output goes to `dist/` folder. Preview with:

```bash
npm run preview
```

## GitHub Pages Deployment

### 1. Prepare Your Repository

```bash
git add .
git commit -m "Clean up project structure for GitHub Pages"
git push origin main
```

### 2. Enable GitHub Pages

1. Go to your repository on GitHub
2. **Settings** → **Pages**
3. Select:
   - Source: "Deploy from a branch"
   - Branch: `main` / `root`
4. Click "Save"

Your site will be available at: `https://your-username.github.io/kmb-route-master-web/`

### 3. Set API Keys as Secrets

GitHub Actions needs your API keys to build the app.

1. Go to **Settings** → **Secrets and variables** → **Actions**
2. Click **New repository secret**
3. Add:
   - **Name:** `VITE_GEMINI_API_KEY` | **Value:** Your Gemini API key
   - **Name:** `GCP_API_KEY` | **Value:** Your GCP key (optional)
4. Click "Add secret"

### 4. Deploy

Simply push to `main` branch:

```bash
git push origin main
```

GitHub Actions will automatically:
1. ✅ Install dependencies
2. ✅ Build the project using your secrets
3. ✅ Deploy to GitHub Pages

Check deployment status: **Actions** tab in your repository

## iPhone Access

### Method 1: Add to Home Screen (Recommended)

1. **Open in Safari:**
   - Safari → Address bar → `https://your-username.github.io/kmb-route-master-web/`
2. **Add to Home Screen:**
   - Tap Share (bottom menu) → "Add to Home Screen"
   - Name it (e.g., "KMB Master")
   - Tap "Add"

The app will now appear as an icon on your home screen and launch with a native app appearance.

### Method 2: Bookmark

1. Open the URL in Safari
2. Tap Share → "Add Bookmark"
3. Save to your home screen folder

## Troubleshooting

### Issue: UI Different on iPhone vs Localhost

**Cause:** Webpack/module loading differences  
**Solution:** 
- Ensure `vite.config.js` has correct `base: '/kmb-route-master-web/'`
- Check `.github/workflows/deploy.yml` artifacts path is `./dist`
- Clear iPhone Safari cache: Settings → Safari → Clear History and Website Data

### Issue: Assets Not Loading on GitHub Pages

**Check:**
1. Open DevTools (F12) → Network tab
2. Verify all asset URLs start with `/kmb-route-master-web/`
3. Check `.github/workflows/deploy.yml` runs successfully

### Issue: API Key Not Working

**Check:**
1. Verify secret is set in GitHub Settings
2. Verify key name matches: `VITE_GEMINI_API_KEY`
3. Key should be accessible via `import.meta.env.VITE_GEMINI_API_KEY`
4. Rebuild & redeploy after adding secret

### Issue: Maps Not Showing

**Check:**
1. ArcGIS script loads in index.html
2. Check browser Network tab for: `https://js.arcgis.com/4.29/`
3. Check console for errors (F12 → Console)
4. Verify Hong Kong coordinates: `22.3° N, 114.2° E`

## File Descriptions

| File | Purpose |
|------|---------|
| `index.html` | HTML entry point, loads ArcGIS & React |
| `src/main.jsx` | React boot point, registers PWA service worker |
| `src/App.jsx` | Main app component with map & search logic |
| `vite.config.js` | Build config, PWA manifest, base URL setup |
| `.github/workflows/deploy.yml` | GitHub Actions CI/CD pipeline |
| `.env.example` | Template for API keys (never commit with values!) |
| `.gitignore` | Excludes node_modules, dist, .env |

## Key Technologies

| Tech | Purpose |
|------|---------|
| **React 18** | UI framework |
| **Vite** | Fast build tool |
| **Tailwind CSS v4** | Utility styling |
| **ArcGIS JS SDK** | Maps rendering |
| **Gemini API** | AI insights |
| **Vite PWA** | Offline support, installable app |

## Performance Tips

- Icons (PWA) are in `public/` for static serving
- Pre-built assets use Vite's automatic splitting
- Service Worker pre-caches essential files
- Max cache size: 4MB (configured in vite.config.js)

## Next Steps

1. Update `package.json` repository URL to your GitHub repo
2. Customize app name/description in `.github/workflows/deploy.yml`
3. Add GitHub repository secrets (API keys)
4. Push to main and watch GitHub Actions deploy
5. Test on iPhone by adding to home screen

---

**Questions?** Check browser console (F12 → Console) for errors.
