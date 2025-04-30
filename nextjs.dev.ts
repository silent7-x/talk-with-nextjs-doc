import fs from "fs/promises";
import { chromium } from "playwright";

async function scrapeNextJS() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto("https://nextjs.org/docs");

    // Scraping example
    // const title = await page.title();
    // console.log("Page title:", title);

    //get the nav element
    const nav = await page.$("nav.styled-scrollbar");
    if (!nav) {
      throw new Error("nav element not found");
    }

    //get the links elements in the nav
    const links = await nav?.$$("a");
    if (!links) {
      throw new Error("link element not found");
    }

    //get the url of the links
    const urls = await Promise.all(
      links.map(async (link) => {
        const href = await link.getAttribute("href");
        return href;
      })
    );

    for (const url of urls) {
      try {
        console.log("👀 Visiting", url);
        await page.goto(`https://nextjs.org${url}`, { timeout: 60000 });

        // get the content of div.prose.prose-vercel
        const content = await page.$eval(
          "div.prose.prose-vercel",
          (el) => el.textContent
        );

        if (!content) {
          console.log("⚠️ No content found for", url);
          continue;
        }

        const encodedUrlForFileName = `https://nextjs.org${url}`.replace(
          /\/|\./g,
          "_"
        );

        const filePath = `./data/nextjs/${encodedUrlForFileName}.txt`;

        // write the content to the file
        await fs.writeFile(filePath, content);

        console.log("🛟 Save", filePath);
      } catch (error: any) {
        console.error(`❌ Error scraping ${url}:`, error.message);
        continue;
      }
    }
  } catch (error) {
    console.error("Erreur lors du scraping:", error);
  } finally {
    await browser.close();
  }
}

scrapeNextJS();
