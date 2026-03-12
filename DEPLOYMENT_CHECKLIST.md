# GitHub Deployment Checklist

## Pre-Deployment ✅ READY

- [x] Project structure cleaned (removed preview.html, server.py, test files)
- [x] Public folder optimized (removed CDN scripts)
- [x] Vite config updated (proper PWA paths for GitHub Pages)
- [x] Documentation created (SETUP.md, CHANGES.md)
- [x] API key template added (.env.example)
- [x] README updated with iPhone instructions
- [x] Git already initialized (.git folder exists)

## Before First Push

### 1. Verify Local Setup
```bash
cd "KMB-Routing_web_VS"
npm install
npm run dev
```
✅ Should start at http://localhost:5173

### 2. Create/Update GitHub Repository

If you don't have a repository yet:
```bash
# Initialize git (already done)
git config user.email "your-email@example.com"
git config user.name "Your Name"

# Add remote
git remote add origin https://github.com/your-username/kmb-route-master-web.git
git branch -M main
```

Check existing remote:
```bash
git remote -v
```

### 3. Commit Changes
```bash
git add .
git commit -m "Clean up project structure for GitHub Pages deployment

- Remove legacy preview.html and test files
- Clean up public folder (remove CDN scripts)
- Update Vite config for GitHub Pages base path
- Add comprehensive deployment documentation
- Update README with iPhone setup instructions"

git push origin main
```

## After First Push

### 1. Configure GitHub Pages (5 min)

1. Go to your repository on GitHub
2. **Settings** → **Pages**
3. Source: "Deploy from a branch"
4. Branch: `main` / root
5. Click "Save"

### 2. Set API Secrets (2 min)

1. **Settings** → **Secrets and variables** → **Actions**
2. Click **New repository secret**
3. Add:
   ```
   Name: VITE_GEMINI_API_KEY
   Value: [your-gemini-api-key]
   ```
4. Click "Add secret"
5. Repeat for `GCP_API_KEY` (optional)

### 3. Trigger Deployment

After setting secrets, push an empty commit to trigger build:

```bash
git commit --allow-empty -m "Trigger deployment after setting secrets"
git push origin main
```

OR just visit your repo on GitHub and re-run the latest workflow.

### 4. Monitor Deployment

1. Go to your repository
2. Click **Actions** tab
3. Watch the "Deploy static content to Pages" workflow
4. ✅ All steps should pass (green checkmarks)
5. Once complete, URL shown at bottom: 
   ```
   https://your-username.github.io/kmb-route-master-web/
   ```

## Testing on iPhone 🍎

### Step 1: Open in Safari
- Open Safari app
- Type URL: `https://your-username.github.io/kmb-route-master-web/`

### Step 2: Add to Home Screen
1. Tap **Share** button (bottom right)
2. Scroll down, tap **"Add to Home Screen"**
3. Name: "KMB Master" (or your preference)
4. Tap **"Add"**

### Step 3: Launch App
- Icon appears on home screen
- Taps launch with native app appearance
- Works offline (with cache from first load)

## Troubleshooting 🔧

### App not showing up in GitHub Pages

**Check:**
1. Go to `https://your-username.github.io/kmb-route-master-web/`
2. Open DevTools (F12)
3. Check **Console** tab for errors
4. Check **Network** tab: are JS files loading from correct path?

**Common issues:**
- Base path wrong in vite.config.js
- Secrets not properly set in GitHub
- workflow doesn't have permission

### Different UI on GitHub vs localhost

**This should be fixed now!**
- Both use Vite build system
- Same code path
- Same asset loading

**If still different:**
1. Clear browser cache (Ctrl+Shift+Del)
2. Check browser DevTools Network tab
3. Verify all assets load with correct paths

### Map not showing

1. Check ArcGIS script loads: `https://js.arcgis.com/4.29/`
2. Check console for JavaScript errors
3. Verify Hong Kong coordinates work
4. Try incognito/private window

### API functions not working (AI features)

1. Check secret is set: **Settings** → **Secrets and variables** → **Actions**
2. Secret name must be exactly: `VITE_GEMINI_API_KEY`
3. Rebuild after adding secret:
   ```bash
   git commit --allow-empty -m "Rebuild with API keys"
   git push origin main
   ```
4. Check browser DevTools Network → XHR for API calls

## Files Reference

| File | Purpose |
|------|---------|
| `README.md` | User guide & overview |
| `SETUP.md` | Detailed deployment instructions |
| `CHANGES.md` | Summary of what changed |
| `.env.example` | Template for local .env |
| `vite.config.js` | Build configuration |
| `.github/workflows/deploy.yml` | CI/CD automation |

## Support Links

- **Gemini API:** https://ai.google.dev/
- **GitHub Pages:** https://docs.github.com/en/pages
- **Vite Docs:** https://vitejs.dev/
- **React Docs:** https://react.dev/
- **ArcGIS JS:** https://developers.arcgis.com/javascript/latest/

## Next Steps

1. **Commit & push to GitHub** (see "Before First Push" section)
2. **Configure GitHub Pages** (Settings → Pages)
3. **Set API secrets** (Settings → Secrets)
4. **Test on iPhone** (Add to home screen via Safari)
5. **Monitor deployment** (Actions tab)

---

**Pro Tip:** After first deployment, any push to `main` automatically rebuilds and redeploys! 🚀
