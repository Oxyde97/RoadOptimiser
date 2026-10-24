import asyncio, json, sys
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page(viewport={"width": 900, "height": 700})
        await page.goto("http://127.0.0.1:18099/e2e.html")
        try:
            await page.wait_for_function("window.__result !== undefined", timeout=180000)
        except Exception:
            pass
        txt = await page.evaluate("document.getElementById('out').textContent")
        res = await page.evaluate("window.__p || null")
        print(txt)
        print("RESULT_JSON=" + json.dumps(res))
        await browser.close()

asyncio.run(main())
