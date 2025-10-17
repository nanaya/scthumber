import canvas from 'canvas';
import StatsD from 'hot-shots';
import http from 'http';
import sharp from 'sharp';
import SmartCrop from 'smartcrop';

// canvas doesn't work with esm named imports.
const { createCanvas, Image } = canvas;
const statsd = new StatsD({ prefix: 'scthumber.' });

/**
 * @typedef {import('express').Response} Response
 * @typedef {import('express').Request} Request
 *
 * @typedef {Object} Options
 * @property {string[]} [allowedExtensions]
 * @property {Object.<string, Preset>} [presets]
 */

/**
 * @typedef {Object} Preset
 * @property {number} [height]
 * @property {number} width
 * @property {number} quality 0-100
 */
const defaultPresets = {
  small: {
    width: 120,
    quality: 50,
  },
  medium: {
    width: 300,
    quality: 70,
  },
  large: {
    width: 900,
    quality: 90,
  }
};

/** @type {Object.<string, Preset>} */
let presets;
/** @type {string[]} */
let allowedExtensions;

/**
 * Merge user-provided options with the sensible defaults.
 * @param {Options} options
 */
function parseOptions(options) {
  presets = options.presets ?? defaultPresets;

  allowedExtensions = options.allowedExtensions ?? ['gif', 'png', 'jpg', 'jpeg'];
  for (let i=0; i < allowedExtensions.length; i++) {
    // be forgiving to user errors!
    if (allowedExtensions[i][0] === '.') {
      allowedExtensions[i] = allowedExtensions[i].substring(1);
    }
  }
}

/**
 * @param {...string} messages
 */
function log(...messages) {
  console.log(`[${'%s'.grey}] ${'%s'.white}`, new Date().toISOString(), messages.join(' '));
}

/**
 * @param {string} url
 * @param {http.IncomingMessage} response
 * @param {body} Buffer
 */
function logFetchError(url, response, body) {
  console.log(
    `[${'%s'.grey}] ${'[fetch:%i] %s'.red} %j`,
    new Date().toISOString(),
    response.statusCode,
    url,
    { headers: response.headers, body: body.toString('utf8', 0, 100) }
  );
}

/**
 * @param {string} url
 * @returns {Promise<Buffer>}
 */
function fetchURL(url) {
  return new Promise((resolve, reject) => {
    http.request(url, (response) => {
      const buffer = [];
      response.on('data', (chunk) => buffer.push(chunk));
      response.on('end', () => {
        const data = Buffer.concat(buffer)
        if (response.statusCode < 200 || response.statusCode > 299) {
          logFetchError(url, response, data);
          reject(`Error retrieving image: UPSTREAM ${response.statusCode}`);
        }

        resolve(data);
      });
    })
    .on('error', reject)
    .end();
  });
}

/**
 * @param {Buffer} inputBuffer
 * @param {Preset} preset
 * @returns
 */
function resizeImage(inputBuffer, preset) {
  return new Promise((resolve, reject) => {
    if (!preset.width) {
      reject('preset width not set');
    }

    if (!preset.quality) {
      preset.quality = 94;
    }

    if (!preset.height) {
      preset.height = preset.width;
    }

    const pixelScale = preset.pixelScale ?? 1;
    const canvasOptions = {
      'canvasFactory': function(w, h) { return createCanvas(w, h); },
      'width': preset.width * 2,
      'height': preset.height * 2,
    };

    const img = new Image();
    img.src = inputBuffer;

    // TODO: handle crop promise rejection
    SmartCrop.crop(img, canvasOptions)
      .then((result) => {
        const rect = result.topCrop;
        sharp(inputBuffer)
          .extract({
            'left': rect.x,
            'top': rect.y,
            'width': rect.width,
            'height': rect.height
          })
          .resize(preset.width * pixelScale, preset.height * pixelScale)
          .sharpen()
          .jpeg({ mozjpeg: true, quality: preset.quality })
          .toBuffer()
          .then((output) => {
            resolve(output);
          });
      });
  });
}

/**
 * @param {Buffer} buffer
 */
function optimizeImage(buffer) {
  const transform = sharp(buffer).jpeg({ mozjpeg: true, quality: 94 });
  transform.on('error', () => {
    transform.destroy();
  })

  return transform;
}

/**
 * @param {Options} [opts]
 */
export default function (opts) {
  /**
   * @param {Response} res
   * @param {string} [message]
   * @param {string} failStat
   * @param {number} [statusCode]
   */
  function errorAbort(res, message, failStat, statusCode) {
    statsd.increment(failStat);
    res.writeHead(statusCode ?? 400);
    res.end(message ?? 'invalid arguments');
  }

  /**
   * @param {Error} err
   * @param {Request} req
   * @param {Response} res
   */
  function handleFetchError(err, req, res) {
    log(`ERR: ${req.originalUrl} [${err}]`.red);
    errorAbort(res, `Error retrieving image: ${err}`, 'upstream_error', 502);
  }

  /**
   * @param {Response} res
   * @param {string} [message]
   */
  function invalidArgsAbort(res, message) {
    errorAbort(res, message ?? 'invalid arguments', 'arg_error');
  }

  /**
   * @param {Request} req
   * @param {Buffer} data
   * @param {Date} startTime
   * @param {import('hot-shots').Tags} [tags]
   */
  function logOk(req, data, startTime, tags) {
    const elapsed = Date.now() - startTime;
    log(`OK: ${req.originalUrl} (src: ${Math.round(data.length/1024)}KB) [${elapsed}ms]`.green);
    // TODO: really just image transform + download time - that will change later.
    statsd.timing('request_time', elapsed, tags);
  }

  /**
   * @param {Request} req
   * @param {Response} res
   */
  async function thumbnail(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { return invalidArgsAbort(res); }

    // Is this a request to a thumbnail image?
    const regexp = new RegExp('^\/thumb\/([A-Za-z0-9_@]+)\/([%\.\-A-Za-z0-9_@=\+]+\.(?:' + allowedExtensions.join('|') + '))(\\?[0-9]+)?$', 'i');
    const thumbRequestParts = req.originalUrl.match(regexp);
    if (!thumbRequestParts) {
      return invalidArgsAbort(res);
    }

    const imagePreset = thumbRequestParts[1];
    if (!presets[imagePreset]) {
      // invalid preset?
      return invalidArgsAbort(res);
    }

    let upstreamURL = "http://" + thumbRequestParts[2];
    if (thumbRequestParts[3] != undefined)
      upstreamURL += thumbRequestParts[3];

    const request_start = Date.now();
    log(`Thumbnailing ${req.originalUrl}...`);
    try {
      const data = await fetchURL(upstreamURL);
      const image = await resizeImage(data, presets[imagePreset]);

      optimizeImage(image).on('end', () => {
        logOk(req, data, request_start, { op: 'thumb', size: imagePreset });
      }).on('error', (error) => {
        log(`ERR: ${req.originalUrl} [${error}]`.red);
        errorAbort(res, `Error thumbnailing image: ${error}`, 'thumb_error', 500);
      }).pipe(res);
    } catch (err) {
      handleFetchError(err, req, res);
    }
  }

  /**
   * @param {Request} req
   * @param {Response} res
   */
  async function optimize(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { return invalidArgsAbort(res); }

    const regexp = new RegExp('^\/optim\/([%\.\-A-Za-z0-9_@=\+]+\.(?:' + allowedExtensions.join('|') + '))(\\?[0-9]+)?$', 'i');
    const thumbRequestParts = req.originalUrl.match(regexp);
    if (!thumbRequestParts) {
      return invalidArgsAbort(res);
    }

    let upstreamURL = "http://" + thumbRequestParts[1];
    if (thumbRequestParts[2] != undefined)
      upstreamURL += thumbRequestParts[2];

    const request_start = Date.now();
    log(`Optimizing ${req.originalUrl}...`);

    try {
      const data = await fetchURL(upstreamURL);

      optimizeImage(data).on('end', () => {
        logOk(req, data, request_start, { op: 'optim' });
      }).on('error', (error) => {
        log(`ERR: ${req.originalUrl} [${error}]`.red);
        errorAbort(res, `Error optimizing image: ${error}`, 'thumb_error', 500);
      }).pipe(res);
    } catch (err) {
      handleFetchError(err, req, res);
    }
  }

  parseOptions(opts ?? {});

  return {
    thumbnail,
    optimize,
  };
};
