import { debounce, fetch, getAppData, setAppData } from '@93m/common'
import chokidar from 'chokidar'
import debug from 'debug'
import fs from 'node:fs/promises'

const logger = debug("rapptor:app.93million.jellyfin:proxyHandlers");

const internalAPIKeyName = 'RapptorInternal'

const getAuthHeaderFromKey = (apiKey) => {
  return [
    'MediaBrowser Client="Rapptor App app.93million.jellyfin"',
    'Device="Rapptor"',
    'Version="10.11.1"',
    `Token="${apiKey}"`
  ].join(', ')
}

const getApiKeys = async (apiKey) => {
  const authorization = getAuthHeaderFromKey(apiKey)
  const request = await fetch(
    'http://app.93million.jellyfin:8096/Auth/Keys',
    { headers: { authorization } }
  )

  if (!request.ok) {
    throw new Error(`Error reponse code when getting /Auth/Keys (${request.status})`)
  }

  const response = await request.json()

  return response
}

const getVirtualFolders = async (apiKey) => {
  const authorization = getAuthHeaderFromKey(apiKey)
  const request = await fetch(
    'http://app.93million.jellyfin:8096/Library/VirtualFolders',
    { headers: { authorization } }
  )

  const response = await request.json()

  return response
}

const createInternalAPIKey = async (apiKey) => {
  const authorization = getAuthHeaderFromKey(apiKey)
  const response = await fetch(
    `http://app.93million.jellyfin:8096/Auth/Keys?App=${internalAPIKeyName}`,
    { headers: { authorization }, method: 'POST' }
  )

  if (!response.ok) {
    throw new Error(`Failed to crete key ${internalAPIKeyName}. Error code ${response.status}`)
  }

  logger(`Created Jellyfin API key '${internalAPIKeyName}'`)
}

const getInternalKeyFromAPI = async (apiKey) => {
  const apiKeys = await getApiKeys(apiKey)

  return apiKeys.Items.find((apiKey) => {
    return apiKey.AppName === internalAPIKeyName
  })?.AccessToken
}

const getOrCreateInternalAPIKey = async (apiKey) => {
  let internalKey = await getInternalKeyFromAPI(apiKey)

  if (internalKey === undefined) {
    logger(`API key not found in list of API keys. Creating new key`)
    await createInternalAPIKey(apiKey)
    internalKey = await getInternalKeyFromAPI(apiKey)
    logger(`Created API key ${internalKey} for use by Rapptor`)
  }

  return internalKey
}

const getScheduledTasks = async (apiKey) => {
  const authorization = getAuthHeaderFromKey(apiKey)
  const request = await fetch(
    'http://app.93million.jellyfin:8096/ScheduledTasks?isHidden=false',
    { headers: { authorization } }
  )

  const response = await request.json()

  return response
}

let tasks

const refreshLibrary = async (apiKey) => {
  if (tasks === undefined) {
    tasks = await getScheduledTasks(apiKey)
  }

  const refreshLibraryTask = tasks.find((task) => {
    return task.Key === 'RefreshLibrary'
  })

  const authorization = getAuthHeaderFromKey(apiKey)
  await fetch(
    `http://app.93million.jellyfin:8096/ScheduledTasks/Running/${refreshLibraryTask.Id}`,
    { headers: { authorization }, method: 'POST' }
  )

  logger(`Refreshing all libraries (task ${refreshLibraryTask.Id})`)
}

let jellyFinConfigured = false

const appDataKey = 'apiKey'

const getApiKeyFromAppData = async () => {
  return getAppData('app.93million.jellyfin', appDataKey)
}

const writeApiKeyToAppData = async (apiKey) => {
  return setAppData('app.93million.jellyfin', appDataKey, apiKey)
}

const scanVirtualFolder = async (apiKey, virtualFolderId) => {
  const url = `http://app.93million.jellyfin:8096/Items/${virtualFolderId}/Refresh?Recursive=true&ImageRefreshMode=Default&MetadataRefreshMode=Default&ReplaceAllImages=false&RegenerateTrickplay=false&ReplaceAllMetadata=false`
  const authorization = getAuthHeaderFromKey(apiKey)
  const response = await fetch(url, { headers: { authorization }, method: 'POST' })
  const response2 = await fetch(url, { headers: { authorization }, method: 'POST' })

  if (!response.ok || !response2.ok) {
    throw new Error(`Failed to rescan virtual folder ${virtualFolderId}. Error code ${response.status}`)
  }

  logger(`Rescanned virtual folder ${virtualFolderId}`)
}

const parseAuthHeader = (authHeader) => {
  const headerParsed = (authHeader ?? '')
    .split(',')
    .reduce((acc, headerItem) => {
      const [itemName, itemValWithQuotes] = headerItem.trim().split('=')
      const itemVal = itemValWithQuotes.replace(/(^"|"$)/g, '')

      return { ...acc, [itemName]: itemVal }
    }, {})

  return headerParsed
}

const sessionApiKeys = []

const configureJellyfin = async () => {
  try {
    const apiKey = await getAndStoreApiKey()

    if (apiKey !== undefined) {
      const virtualFolders = await getVirtualFolders(apiKey)
      await refreshLibrary(apiKey)
      await watchForFSUpdates(apiKey, virtualFolders)

      jellyFinConfigured = true
    }
  } catch (e) {
    console.error('configureJellyfin() Error during configuration', e)
  }
}

const ignoreFileRes = [/\.part$/]

const watchForFSUpdates = async (apiKey, virtualFolders) => {
  virtualFolders.forEach((virtualFolder) => {
    virtualFolder.Locations.forEach(async (location) => {
      let prevNumFilesInDir = (await fs.readdir(location))
        .filter((filename) => !filename.match(ignoreFileRes))
        .length
      logger(`watching for FS updates in ${location} (num files: ${prevNumFilesInDir})`)

      const scan = debounce(
        async (filename) => {
          try {
            const filesInDir = (await fs.readdir(location))
              .filter((filename) => !filename.match(ignoreFileRes))
            const numFilesInDir = filesInDir.length

            logger(`FS change in ${filename}`)

            if (prevNumFilesInDir === 0 && numFilesInDir !== 0) {
              logger(`Refreshing Jellyfin library. Dir ${location} previously had 0 files. Now has ${numFilesInDir}.`)
              await refreshLibrary(apiKey)
            } else {
              logger(`Refreshing jellyfin folder ${virtualFolder.ItemId}`)
              await scanVirtualFolder(apiKey, virtualFolder.ItemId)
            }

            prevNumFilesInDir = numFilesInDir
          } catch (e) {
            console.error('Error during scan', e)
          }
        },
        2 * 1000,
        { leading: false }
      )

      const handleFileChange = (filename) => {
        const shouldBeIgnored = ignoreFileRes
          .some((ignoreFileRe) => filename.match(ignoreFileRe))

        if (!shouldBeIgnored) {
          scan(filename)
        } else {
          logger(`Ignoring FS change in file ${filename} as filename should be ignored`)
        }
      }

      chokidar
        .watch(location, { ignoreInitial: true })
        .on('add', handleFileChange)
        .on('unlink', handleFileChange);
    })
  })
}

const getAndStoreApiKey = async () => {
  const storedApiKey = await getApiKeyFromAppData()
  const apiKeys = [...sessionApiKeys]

  if (storedApiKey !== undefined) {
    apiKeys.unshift(storedApiKey)
  }

  const apiKey = await apiKeys.reduce(
    async (acc, apiKey) => {
      if (await acc !== undefined) {
        return acc
      } else {
        try {
          const appKeyFromApi = await getOrCreateInternalAPIKey(apiKey)

          if (appKeyFromApi !== undefined && appKeyFromApi !== apiKey) {
            writeApiKeyToAppData(appKeyFromApi)
          }

          return appKeyFromApi
        } catch (e) {
          return undefined
        }
      }
    },
    Promise.resolve(undefined)
  )

  return apiKey
}

const configureJellyfinDebounced = debounce(configureJellyfin, 2000, { leading: true })

export const onProxyRequest = async (req, res) => {
  if (jellyFinConfigured === true) {
    return
  }

  if (req.headers?.authorization !== undefined) {
    const authHeaderParsed = parseAuthHeader(req.headers.authorization)

    if (
      authHeaderParsed.Token !== undefined &&
      !sessionApiKeys.includes(authHeaderParsed.Token)
    ) {
      sessionApiKeys.push(authHeaderParsed.Token)
    }
  }

  configureJellyfinDebounced()
}
