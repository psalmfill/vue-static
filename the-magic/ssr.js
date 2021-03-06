const isProd = process.env.NODE_ENV === "production";
const colors = require('colors')
const path = require("path");
const url = require("url");
const fs = require("fs");
const { createBundleRenderer } = require("vue-server-renderer");
const mkdirp = require("mkdirp");
const getDirName = require("path").dirname;
const config = require("../site.config");
const renderMarkdownFile = require("./render-markdown.js");
const chokidar = require('chokidar');
const throttle = require('lodash.throttle')

const rootFolder = path.join(__dirname, "..")

const folders = {
  markdown_folder: path.join(rootFolder, "markdown"),
  output_folder: path.join(rootFolder, "dist"),
  template_html_path: path.join(
    rootFolder,
    "theme",
    "index.template.html"
  ),
  published_html_path: path.join(
    rootFolder,
    "theme",
    "_index.html"
  )
};

const sitemap_template = `<?xml version="1.0" encoding="utf-8" ?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.sitemaps.org/schemas/sitemap/0.9 http://www.sitemaps.org/schemas/sitemap/0.9/sitemap.xsd">
<!-- Urls will be auto injected -->
</urlset>`;

const feed_template = `<?xml version="1.0" encoding="utf-8" ?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${config.site_title}</title>
    <author>${config.author}</author>
    <link>${config.site_url}</link>
    <description>${config.description}</description>
    <atom:link href="${config.site_url}/feed.xml" rel="self" type="application/rss+xml"></atom:link>
    <!-- Urls will be auto injected -->
  </channel>
</rss>`;

function createFile(url, html) {
  url += !path.extname(url) ? ".html" : "";

  url = path.join(folders.output_folder, url);

  mkdirp(getDirName(url), function(err) {
    if (err) console.error(err);
    fs.writeFile(url, html, err => {
      if (err) {
        return console.log(err);
      }
      console.log(colors.grey(`${path.basename(url)}`));
    });
  });
}

const serverBundlePath = path.join(
  folders.output_folder,
  "vue-ssr-server-bundle.json"
);

let markdown_watcher, 
  watch_index_template, 
  template, 
  renderer, 
  files = []



const generate_static_files = (files, index) => {
  console.log(colors.grey(`\n\rGenerating static html files:`));
  console.log(colors.grey(`------------------------------`));

  let files_range = index > -1 ? [files[index]] : files

  files_range.forEach(file => {
    // if (!file || (file.draft && process.env.NODE_ENV === 'production')) {
    //   return;
    // }
    if(!file) { return }

    const context = {
      file,
      files
    };

    renderer.renderToString(context, (err, html) => {
      if (err) {
        console.log(err);
        return false
      }

      const {
        title,
        htmlAttrs,
        bodyAttrs,
        link,
        style,
        script,
        noscript,
        meta
      } = context.meta.inject();

      html = html.replace(
        "<!-- meta tags will be auto injected here -->",
        meta.text() +
          title.text() +
          link.text() +
          style.text() +
          script.text() +
          noscript.text()
      );

      createFile(file.url === "/" ? "/index" : file.url, html);
    });
  });

  let sitemap_string = files
    .filter(file => file.url.indexOf("404") === -1)
    .filter(file => file.url !== "/analytics")
    .map(file => {
      file.url.replace("/(.html$)/", "");
      file.absolute_url = url.resolve(config.site_url, file.url);
      return file;
    })
    .map(file => {
      return `
        <url>
          <loc>${file.absolute_url}</loc>
          <priority>1.0</priority>
          <lastmod>${new Date(file.updated).toISOString()}</lastmod>
        </url>
      `;
    })
    .join("");

  let sitemap_html = sitemap_template.replace(
    "<!-- Urls will be auto injected -->",
    sitemap_string
  );

  createFile("sitemap.xml", sitemap_html);


  let feed_string = files
    .filter(file => file.url.indexOf("404") === -1)
    .map(file => {
      file.absolute_url = url.resolve(config.site_url, file.url).replace("/(.html$)/", "");
      return file;
    })
    .map(file => {
      return `<item>
          <title>${file.title}</title>
          <author>${file.author || config.author}</author>
          <pubdate>${file.created}</pubdate>
          <description>${file.excerpt || config.description}</description>
          <link>${file.absolute_url}</link>
          <guid ispermalink="true">${file.absolute_url}</guid></item>`;
    })
    .join("");

  let feed_xml = feed_template.replace(
    "<!-- Urls will be auto injected -->",
    feed_string
  );

  createFile("feed.xml", feed_xml);
}

let static_timeout

async function addFile(file_path) {
  files = await renderMarkdownFile(file_path, files)

  clearTimeout(static_timeout)

  static_timeout = setTimeout(() => {
    generate_static_files(files)
  }, 200);
}

let double_render_timeout

/**
 * Updating single files instead of all html files will be faster, but if other html files include information from this changed file they won't be updated. This is true for if the page title changes and navigation links are based off the title. This will only be a problem in development, not during a production build. And you won't notice the problem unless you refresh the page on one of the other pages. See solution below
 */
async function updateFile(file_path) {
  files = await renderMarkdownFile(file_path, files)

  let url = file_path.replace(path.join(__dirname, '..'), '')
  let index = files.findIndex(file => file.path === url)

  generate_static_files(files, index)

  clearTimeout(double_render_timeout)

  // Adding this second generate static files will fix the rest.
  double_render_timeout = setTimeout(() => {
    generate_static_files(files)
  }, 2000);
}


function updateHTMLTemplate() {
  template = fs
    .readFileSync(folders.published_html_path, "utf-8")
    .replace('<div id="app"></div>', "<!--vue-ssr-outlet-->");

  renderer = createBundleRenderer(
    serverBundlePath,
    Object.assign(
      {},
      {
        runInNewContext: true,
        template
      }
    )
  );
  generate_static_files(files)
}

function wait(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  })
};

(async function(){

  await wait(1000)

  const watch_server_bundle = chokidar
    .watch(serverBundlePath, {
      persistent: true,
      awaitWriteFinish: {
        stabilityThreshold: 2000,
        pollInterval: 100
      }
    })
    .on('add', async (file) => {

      await wait(500)

      console.log('\n\r', colors.green(`Watching markdown files and theme/index.template.html`), '\n\r')

      updateHTMLTemplate()

      watch_index_template = chokidar
        .watch(folders.template_html_path, {
          persistent: true,
          awaitWriteFinish: {
            stabilityThreshold: 2000,
            pollInterval: 100
          },
        })
        .on('add', updateHTMLTemplate)
        .on('change', updateHTMLTemplate)
        .on('unlink', () => {
          console.log('\n\r', colors.red(`You must have an index.template.html file in your theme for rendering to work.`), '\n\r')})
        .on('error', function(error) {console.error(`Error watching ${folders.template_html_path}:`, error)})

      markdown_watcher = chokidar
        .watch(folders.markdown_folder, {ignored: /^\./, persistent: true})
        .on('add', addFile)
        .on('change', updateFile)
        .on('unlink', function(file_path) {

          let url = file_path.replace(path.join(__dirname, '..'), '')
          let index = files.findIndex(file => file.path === url)

          if(index > -1 && files[index] && files[index].url) {
            let delete_path = path.join(folders.output_folder, files[index].url + '.html')
            try {
              fs.unlinkSync(delete_path)
              files.splice(index, 1)
            } catch(err) {
              
            }
            
          }
          

          console.log(colors.blue(`"${path.basename(url)}" removed.`))
          clearTimeout(static_timeout)

          static_timeout = setTimeout(() => {
            generate_static_files(files)
          }, 200);
        })
        .on('error', function(error) {console.error('Error watching markdown:', error)})
    })
    .on('unlink', () => {
      console.log('\n\r', colors.red(`vue-ssr-server-bundle.json was erased. Markdown files will no longer be watched. Please end this process and rerun 'yarn start' to fix this problem.`), '\n\r')
      markdown_watcher.unwatch(folders.markdown_folder)
      watch_index_template.unwatch(folders.template_html_path)
    })
    .on('error', function(error) {console.error(`Error watching ${serverBundlePath}:`, error)})
})()
