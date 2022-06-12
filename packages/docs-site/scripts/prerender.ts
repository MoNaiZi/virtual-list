// scrape pages from vite preview
import fs from 'fs'
import path from 'path'
// @ts-ignore
import Nightmare from 'nightmare'
import child_process from 'child_process'
// @ts-ignore
import { minify } from 'html-minifier'
import * as hp from 'helper-js'
import axios from 'axios'
import baseConfig from '../src/baseConfig'
import { getLocales } from './utils'

const PREVIEW_URL = `http://localhost:4173` // vite preview
const DIST_PRERENDERED = 'dist-prerendered'
const RETRY = 3

start()

async function start() {
  if (fs.existsSync(DIST_PRERENDERED)) {
    rmDir(DIST_PRERENDERED)
  }
  copyDir('dist', DIST_PRERENDERED)
  // start urls
  const locales = getLocales()
  const urls: string[] = []
  urls.push('/')
  locales.forEach((v) => {
    if (v !== baseConfig.LOCALE) {
      urls.push('/' + v)
    }
  })
  //
  const usedUrls: string[] = []
  const successfulUrls: string[] = []
  let tempUrl: string
  let i = 0
  while (urls.length > 0) {
    tempUrl = urls.shift()!
    usedUrls.push(tempUrl)
    const newUrls = await scrapeOnePage(PREVIEW_URL + tempUrl)
      .then((urls) => {
        successfulUrls.push(tempUrl)
        return urls
      })
      .catch((e) => [])
    newUrls.forEach((v) => {
      if (!urls.includes(v) && !usedUrls.includes(v)) {
        urls.push(v)
      }
    })
    i++
    if (i > 1000) {
      throw 'loop error'
    }
  }
  //
  genSitemapAndRobotsTXT(successfulUrls)
  console.log('prerender done')
}

function copyDir(src: string, dist: string) {
  child_process.spawnSync('cp', ['-r', src, dist])
}

function rmDir(src: string) {
  child_process.spawnSync('rm', ['-rf', src])
}

/**
 *
 * @param url
 * @param opt
 * @param count
 * @returns urls in the page
 */
function scrapeOnePage(url: string, opt = {}, count = 0) {
  const urlWithoutHost = removeHost(url)
  return new Promise<string[]>((resolve, reject) => {
    const nightmare = Nightmare({ show: false, ...opt })
    nightmare
      .goto(url)
      // @ts-ignore
      .wait('title')
      .evaluate(() => {
        const html = document.documentElement.outerHTML
        // get all links
        const urls: string[] = []
        const t: Element[] = []
        t.push(...document.querySelectorAll('a'))
        t.push(...document.querySelectorAll('link[rel="alternate"]'))
        t.forEach((el) => {
          let url = el.getAttribute('href')
          if (!url) {
            return
          }
          url = url.replace(/#.*$/, '') // remove hash
          urls.push(url)
        })
        return { html, urls }
      })
      .end()
      // @ts-ignore
      .then(({ html, urls }: { html: string; urls: string[] }) => {
        html = html.replace(
          '</head>',
          '<script>window.__IS_GENERATED__ = true</script></head>'
        )
        html = html.replaceAll(PREVIEW_URL, baseConfig.ORIGIN_PROD)
        html = minify(`<!DOCTYPE html>${html}`)
        writeFileSyncRecursively(
          path.join(
            DIST_PRERENDERED,
            urlWithoutHost.replace(/\/$/, '') + '/index.html'
          ),
          html
        )
        console.log(`Page scraped:`, urlWithoutHost)
        urls = urls
          .filter((v) => isInternalUrl(v))
          .map((v) => {
            let r = removeHost(v)
            if (r === '') {
              r = '/'
            }
            return r
          })
        resolve(urls)
      })
      .catch((e: Error) => {
        console.log('Page failed:', urlWithoutHost, e)
        if (count < RETRY - 1) {
          console.log('Page retry:', urlWithoutHost)
          resolve(scrapeOnePage(url, opt, count + 1))
        } else {
          reject(e)
        }
      })
  })
}

function writeFileSyncRecursively(filepath: string, contents: string) {
  const dir = path.dirname(filepath)
  if (!fs.existsSync(dir)) {
    // @ts-ignore
    fs.mkdirSync(dir, { recursive: true })
  }
  return fs.writeFileSync(filepath, contents)
}

function removeHost(url: string) {
  return url.replace(/^.*\/\/[^/]+/, '')
}

function isInternalUrl(url: string) {
  try {
    return new URL(url).hostname === new URL(PREVIEW_URL).hostname
  } catch (error) {
    return true
  }
}

function genSitemapAndRobotsTXT(urls: string[]) {
  urls = urls.map((v) => {
    v = baseConfig.ORIGIN_PROD + v
    if (!v.endsWith('/')) {
      v += '/'
    }
    return v
  })
  const lastmod = new Date().toISOString()
  let t = urls
    .map(
      (url) => `<url>
  <loc>${url}</loc>
  <lastmod>${lastmod}</lastmod>
  <priority>${url === baseConfig.ORIGIN_PROD + '/' ? '1.00' : '0.80'}</priority>
</url>`
    )
    .join('\n')
  let r = `<?xml version="1.0" encoding="UTF-8"?>
<urlset
      xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
      xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
      xsi:schemaLocation="http://www.sitemaps.org/schemas/sitemap/0.9
            http://www.sitemaps.org/schemas/sitemap/0.9/sitemap.xsd">
  ${t}
</urlset>`
  fs.writeFileSync(path.join(DIST_PRERENDERED, 'sitemap.xml'), r)
  const hostname = new URL(baseConfig.ORIGIN_PROD).hostname
  fs.writeFileSync(
    path.join(DIST_PRERENDERED, 'robots.txt'),
    `Sitemap: ${hostname}/sitemap.xml`.trim()
  )
}
// TODO ts-node prerender.ts throw error
