NutriSnap - Vercel deploy steps

1. Get a free Gemini API key: https://aistudio.google.com/apikey
2. Install Vercel CLI (one time):   npm i -g vercel
3. In this folder run:              vercel
   (log in, accept the defaults - it's a plain static site + /api function)
4. Add your key:                    vercel env add GEMINI_API_KEY
   (paste the key, select Production + Preview + Development)
5. Deploy to production:            vercel --prod

No CLI? Push this folder to GitHub, import it at vercel.com/new,
add GEMINI_API_KEY under Environment Variables, then click Deploy.

Optional: set GEMINI_MODEL to use a different model (default: gemini-3.8-flash).
