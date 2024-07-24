const puppeteer = require("puppeteer");
const express = require("express");
const app = express();
const csv = require("csv-parser");
const dns = require("dns");
const fs = require("fs");
const sharp = require("sharp");
const request = require("request");

sharp.cache(false);

const cookieDbs = [];
const ipDbs = [];

var _config = JSON.parse(fs.readFileSync("package.json"));

function transKey(key) {
  let keys = key.split("");
  let result = "";
  let isUpper = false;
  keys.forEach((c) => {
    if (c == "_") {
      isUpper = true;
    } else if (isUpper) {
      result += c.toUpperCase();
      isUpper = false;
    } else {
      result += c;
    }
  });
  return result;
}

function translateObject(obj) {
  let output = {};
  for (let [key, val] of Object.entries(obj)) {
    if (key == "network2") continue;
    output[transKey(key)] = val;
  }
  return output;
}

function leadZero(n) {
  if (n < 10) return "0" + n;
  return n;
}

function getScanDate(d) {
  let gmt = d.getTime() + d.getTimezoneOffset() * 60000;
  d.setTime(gmt + 7 * 3600000);
  return (
    leadZero(d.getDate()) +
    "/" +
    leadZero(d.getMonth() + 1) +
    "/" +
    leadZero(d.getFullYear()) +
    " " +
    leadZero(d.getHours()) +
    ":" +
    leadZero(d.getMinutes())
  );
}

function findDomain(url) {
  let pos = url.indexOf("//");
  if (pos < 0) return null;
  url = url.substr(pos + 2);
  pos = url.indexOf("/");
  if (pos < 0) return url;
  return url.substr(0, pos);
}

function readDatabaseIp() {
  console.log("Reading ip database...");
  fs.createReadStream("geoip2-ipv4.csv")
    .pipe(csv())
    .on("data", (data) => {
      let [ip, xx] = data.network.split("/");
      let arr = ip.split(".");
      let count = 0;
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i] == "0") count += 2;
        else break;
      }
      if (count <= 4) {
        data.network2 = ip.substr(0, ip.length - count) + ".";
        ipDbs.push(data);
      }
    })
    .on("end", () => {
      console.log("Completed!");
      startBrowser();
    });
}

function validURL(str) {
  var pattern = new RegExp(
    "^(https?:\\/\\/)?" + // protocol
      "((([a-z\\d]([a-z\\d-]*[a-z\\d])*)\\.)+[a-z]{2,}|" + // domain name
      "((\\d{1,3}\\.){3}\\d{1,3}))" + // OR ip (v4) address
      "(\\:\\d+)?(\\/[-a-z\\d%_.~+]*)*" + // port and path
      "(\\?[;&a-z\\d%_.~+=-]*)?" + // query string
      "(\\#[-a-z\\d_]*)?$",
    "i"
  ); // fragment locator
  return !!pattern.test(str);
}

const url =
  "https://raw.githubusercontent.com/jkwakman/Open-Cookie-Database/master/open-cookie-database.csv";

async function readDatabase() {
  console.log("Reading cookie database...");
  request(url)
    .pipe(csv())
    .on("data", (data) => {
      cookieDbs.push(data);
    })
    .on("end", () => {
      console.log("CSV file successfully processed.");
      readDatabaseIp();
    })
    .on("error", (err) => {
      console.error(err);
    });
}

function findIpDbs(ip) {
  let l = ipDbs.length;
  for (let i = 0; i < l; i++) {
    const check = ipDbs[i];
    if (ip.indexOf(check.network2) == 0) return check;
  }
  return null;
}

function bindResult(cookies) {
  const l = cookies.length;
  for (var i = 0; i < l; i++) {
    var cookie = cookies[i];
    const found = cookieDbs.find(
      (cookie_) => cookie_["Cookie / Data Key name"] === cookie.name
    );
    if (found) {
      cookie.platform = found.Platform;
      cookie.category = found.Category;
      cookie.description = found.Description;
      cookie.retention = found["Retention period"];
      cookie.dataController = found["Data Controller"];
      cookie.gdpr = found["User Privacy & GDPR Rights Portals"];
    }
  }
}

async function lookupIp(domain) {
  return new Promise((resolve, reject) => {
    dns.lookup(domain, (err, ip) => {
      if (err) reject(err);
      else resolve(ip);
    });
  });
}

async function scan(url) {
  let urlChk = url.toLowerCase();
  if (urlChk.indexOf("http://") < 0 && urlChk.indexOf("https://") < 0)
    url = "http://" + url;
  let browser = await launch({
    headless: true,
    args: [
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--no-first-run",
      "--no-zygote",
      "--single-process",
    ],
  });
  const page = await browser.newPage();
  // page.setDefaultNavigationTimeout(45000);
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    if (request.resourceType() === "image") request.abort();
    else request.continue();
  });
  await page.goto(url, { waitUntil: "networkidle2" });

  var cookies = await page.cookies();

  bindResult(cookies);

  await page.close();

  await browser.close();

  return cookies;
}

// async function resizeImage(imgPath) {
// 	return new Promise((resolve, reject) => {

// 	});
// }

async function delFile(filePath) {
  return new Promise((resolve, reject) => {
    fs.unlink(filePath, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

let fixCategories = ["Necessary", "Analytics", "Marketing", "Unclassified"];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function scanV2(url) {
  let urlChk = url.toLowerCase();
  if (urlChk.indexOf("http://") < 0 && urlChk.indexOf("https://") < 0)
    url = "http://" + url;
  const browser = await puppeteer.launch({
    headless: false,
    args: [
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--no-first-run",
      "--no-zygote",
      "--single-process",
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  page.setDefaultNavigationTimeout(45000);
  await page.goto(url, { waitUntil: "networkidle2" });
  await sleep(5000);
  const cookies = await page.cookies();

  // Load the previously saved cookies
  await page.setCookie(...cookies);

  // Get the second page's cookies
  const cookiesSet = await page.cookies();

  bindResult(cookiesSet);

  const domain = findDomain(url);

  await page.screenshot({
    quality: 80,
    type: "jpeg",
    path: domain + ".jpg",
  });

  const buff = await sharp(domain + ".jpg")
    .resize(800, 450)
    .jpeg({
      quality: 80,
    })
    .toBuffer();

  await delFile(domain + ".jpg");

  await page.close();

  await browser.close();

  const serverInfo = {};
  try {
    const domain = findDomain(url);
    const ip = await lookupIp(domain);
    serverInfo.ip = ip;
    const ipinfo = findIpDbs(ip);
    if (ipinfo) {
      serverInfo.location = translateObject(ipinfo);
    }
  } catch (e) {
    console.log(e);
  }

  const categories = {};
  fixCategories.forEach((cate) => {
    categories[cate] = 0;
  });

  cookiesSet.forEach((cookie) => {
    const cate = cookie.category;
    if (cate && fixCategories.indexOf(cate) >= 0) {
      categories[cate]++;
    } else if (cate) {
      if (!categories[cate]) categories[cate] = 0;
      categories[cate]++;
    } else {
      categories["Unclassified"]++;
    }
  });

  return {
    url: url,
    scanDate: getScanDate(new Date()),
    server: serverInfo,
    screenshot: "data:image/jpeg;base64, " + buff.toString("base64"),
    categories: categories,
    total: cookiesSet.length,
    cookies: cookiesSet,
  };
}

async function startBrowser() {
  await startApi();
}

async function startApi() {
  console.log("Starting api...");

  app.get("/health", function (req, res) {
    res.send(_config.version);
  });

  app.get("/scan", async (req, res) => {
    if (!req.query.url) {
      res.status(400);
      res.send("No param url");
      return;
    }
    if (!validURL(req.query.url)) {
      res.status(400);
      res.send("Invalid url");
      return;
    }
    try {
      const cookies = await scan(req.query.url);
      res.send(cookies);
    } catch (e) {
      res.status(400);
      res.send("Something went wrong");
      console.log(e);
    }
  });

  app.get("/scan2", async (req, res) => {
    if (!req.query.url) {
      res.status(400);
      res.send("No param url");
      return;
    }
    if (!validURL(req.query.url)) {
      res.status(400);
      res.send("Invalid url");
      return;
    }
    try {
      const cookies = await scanV2(req.query.url);
      res.send(cookies);
    } catch (e) {
      res.status(400);
      res.send(e);
      console.log(">>>>>>>>>>>>>>>>>>>>>>>>>>>>", e);
    }
  });

  app.listen(5555);
  console.log("App v" + _config.version + " running on port 5555");
}

process.on("SIGTERM", async () => {
  await browser.close();
  console.log("Browser closed");
});

readDatabase();
