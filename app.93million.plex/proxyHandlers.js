import dns from 'node:dns'
import fetch from 'node-fetch'
// import {HttpsProxyAgent} from 'https-proxy-agent'

const plexContainerIpPromise = dns.promises.lookup('app.93million.plex')
const proxyContainerIpPromise = dns.promises.lookup(process.env.RAPPTOR_CONTROL_PANEL_SERVICE_URL_INTERNAL.replace(/:\d+$/, ''))
let plexIsConfigured = false
// const proxyAgent = new HttpsProxyAgent('http://localhost:8888')

const settingValueGetters = {
  bool: (setting) => setting.value === "1",
  default: (setting) => setting.value
}

const getPrefs = async (headers, searchParams) => {
  const response = await fetch(
    'http://app.93million.plex:32400/:/prefs?' + searchParams.toString(),
    {
      // agent: proxyAgent,
      headers: { ...headers, accept: 'application/json' }
    }
  )
  const responseBody = await response.text()
  const doc = JSON.parse(responseBody)
  return doc
    .MediaContainer
    .Setting
    .reduce(
      (acc, setting) => {
        const valueGetter = settingValueGetters[setting.type] ?? settingValueGetters.default
        return { ...acc, [setting.id]: valueGetter(setting) }
      },
      {}
    )
}

const setPref = async (name, value, headers) => {
  const response = await fetch(`http://app.93million.plex:32400/:/prefs?${name}=${value}`, { headers, method: 'PUT' })
}

const additionalSearchParams = {
  movies: {
    type: 'movie',
    agent: 'tv.plex.agents.movie',
    scanner: 'Plex Movie',
    language: 'en-GB',
    importFromiTunes: '',
    enableAutoPhotoTags: ''
  },
  music: {
    type: 'artist',
    agent: 'tv.plex.agents.music',
    scanner: 'Plex Music',
    language: 'en-GB',
    importFromiTunes: '',
    enableAutoPhotoTags: ''
  },
  tv: {
    type: 'show',
    agent: 'tv.plex.agents.series',
    scanner: 'Plex TV Series',
    language: 'en-GB',
    importFromiTunes: '',
    enableAutoPhotoTags: ''
  }
}

const addLibrary = async (type, name, locations, headers, searchParams) => {
  const librarySearchParams = new URLSearchParams(searchParams)
  locations.forEach(location => librarySearchParams.append('location', location))
  Object.keys(additionalSearchParams[type]).forEach((name) => librarySearchParams.append(name, additionalSearchParams[type][name]))
  librarySearchParams.append('name', name)
  const response = await fetch(`http://app.93million.plex:32400/library/sections?${librarySearchParams}`, { headers, method: 'POST' })
  if (response.status < 200 || response.status > 299) {
    throw new Error("Unable to add library")
  }
}

const getLibraries = async (headers, searchParams) => {
  const response = await fetch(`http://app.93million.plex:32400/library/sections?${searchParams}`, { headers: {...headers, accept: 'application/json'}, method: 'GET' })
  const jsonBody = await response.text()
  return JSON.parse(jsonBody)
}

let debounceFnRunning = false
const debounceFn = (fn, timeout = 0) => async (...args) => {
  if (debounceFnRunning) {
    return
  }

  debounceFnRunning = true

  await fn(...args)
  await new Promise(res => setTimeout(res, timeout))

  debounceFnRunning = false
}

const libraries = [
  { type: 'movies', name: 'Movies', location: '/files/Movies' },
  { type: 'music', name: 'Music', location: '/files/Music' },
  { type: 'tv', name: 'TV Shows', location: '/files/TV Shows'}
]

const getFriendlyNameFromHost = (host) => {
  return host.split('.').slice(1).join('.')
}

const plexConfigurers = [
  {
    test: (prefs, libraryNames) => !!prefs.FriendlyName,
    configure: async (headers, searchParams, friendlyName) => {
      await setPref('FriendlyName', friendlyName, headers)
    }
  },
  {
    test: (prefs, libraryNames) => !!prefs.ManualPortMappingMode,
    configure: async (headers, searchParams, friendlyName) => {
      await setPref('ManualPortMappingPort', '32400', headers)
      await setPref('ManualPortMappingMode', '1', headers)
    }
  },
  {
    test: (prefs, libraryNames) => (
      !!prefs.FSEventLibraryUpdatesEnabled &&
      !!prefs.FSEventLibraryPartialScanEnabled
    ),
    configure: async (headers, searchParams, friendlyName) => {
      await setPref('FSEventLibraryUpdatesEnabled', '1', headers)
      await setPref('FSEventLibraryPartialScanEnabled', '1', headers)
    }
  },
  {
    test: (prefs, libraryNames) => (!!prefs.PublishServerOnPlexOnlineKey),
    configure: async (headers, searchParams, friendlyName) => {
      await setPref('PublishServerOnPlexOnlineKey', 'true', headers)
    }
  },
  ...libraries.map((library) => ({
    test: (prefs, libraryNames) => libraryNames.includes(library.name),
    configure: async (headers, searchParams, friendlyName) => addLibrary(
      library.type,
      library.name,
      ['/files/Downloads', library.location],
      headers,
      searchParams
    )
  }))
]

const configurePlex = async (headers, searchParams, friendlyName) => {
  let prefs
  let libraries
  try {
    prefs = await getPrefs(headers, searchParams)
    libraries = await getLibraries(headers, searchParams)
  } catch (e) {
    console.error('Error getting prefs and libraries', e)
    return
  }
  const libraryNames = libraries.MediaContainer.Directory?.map(({ title }) => title) ?? []
  plexIsConfigured = plexConfigurers.every(configurer => configurer.test(prefs, libraryNames))
  if (!plexIsConfigured) {
    plexIsConfigured = (
      await Promise.all(plexConfigurers.map(async (configurer) => {
          if (configurer.test(prefs, libraryNames)) {
            return true
          } else {
            try {
              await configurer.configure(headers, searchParams, friendlyName)
              return true
            } catch (e) {
              console.error(`Attempt to configure Plex failed`, e)
              return false
            }
          }
        })
      )
    )
      .every(Boolean)
  }
}

export const onProxyRequest = async (req, res) => {
  const url = new URL(`http://${req.headers.host}${req.url}`)
  const proxyContainerIp = (await proxyContainerIpPromise).address
  const plexContainerIp = (await plexContainerIpPromise).address
  const additionalHeaders = {
    host: proxyContainerIp,
    origin: `http://${proxyContainerIp}:4002`,
    referer: `http://${plexContainerIp}:32400/web/index.html`
  }
  const headers = { ...req.headers, ...additionalHeaders }

  if (!plexIsConfigured && url.searchParams.get('X-Plex-Session-Id')) {
    debounceFn(configurePlex, 2000)(headers, url.searchParams, getFriendlyNameFromHost(req.headers.host))
  }

  return { headers }
}
