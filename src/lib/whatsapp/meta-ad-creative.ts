/**
 * Meta Ad & Creative resolution service.
 *
 * Resolves real Meta Ad Creatives (images, thumbnails, copy, campaigns, adsets)
 * directly from the Meta Graph API v21.0.
 *
 * Strict Rule: Ad preview NEVER falls back to property media or general photos.
 * The creative MUST represent the actual Meta Ad linked to that Ad ID.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

const META_API_VERSION = 'v21.0'
const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`

export type CreativeType = 'image' | 'video' | 'carousel' | 'dynamic' | 'link' | 'unknown'

export interface MetaAdCreativeResult {
  success: boolean
  ad_source_id: string
  ad_name: string | null
  campaign_name: string | null
  adset_name: string | null
  ad_status: string | null
  creative_id: string | null
  creative_image_url: string | null
  creative_thumbnail_url: string | null
  creative_type: CreativeType
  headline: string | null
  body: string | null
  source_url: string | null
  raw_error?: string | null
}

interface RawMetaCreative {
  id?: string
  name?: string
  title?: string
  body?: string
  image_url?: string
  thumbnail_url?: string
  video_id?: string
  effective_object_story_id?: string
  object_story_spec?: {
    link_data?: {
      message?: string
      name?: string
      picture?: string
      link?: string
      child_attachments?: Array<{
        picture?: string
        name?: string
        link?: string
      }>
    }
    video_data?: {
      image_url?: string
      video_id?: string
      message?: string
      title?: string
    }
    photo_data?: {
      url?: string
      caption?: string
    }
  }
  asset_feed_spec?: {
    images?: Array<{ url?: string; hash?: string }>
    videos?: Array<{ video_id?: string; thumbnail_url?: string }>
    bodies?: Array<{ text?: string }>
    titles?: Array<{ text?: string }>
    link_urls?: Array<{ website_url?: string }>
  }
}

interface RawMetaAdResponse {
  id?: string
  name?: string
  status?: string
  campaign?: { id?: string; name?: string }
  adset?: { id?: string; name?: string }
  creative?: RawMetaCreative
  objective?: string
  error?: {
    message?: string
    code?: number
    error_subcode?: number
    type?: string
  }
}

/**
 * Resolves ad metadata and visual creative assets directly from Meta Graph API.
 */
export async function fetchMetaAdCreative(
  adSourceId: string,
  accessToken: string,
): Promise<MetaAdCreativeResult> {
  const cleanAdId = adSourceId.trim()
  if (!cleanAdId || !/^\d{10,24}$/.test(cleanAdId)) {
    return {
      success: false,
      ad_source_id: cleanAdId,
      ad_name: null,
      campaign_name: null,
      adset_name: null,
      ad_status: null,
      creative_id: null,
      creative_image_url: null,
      creative_thumbnail_url: null,
      creative_type: 'unknown',
      headline: null,
      body: null,
      source_url: null,
      raw_error: 'ID de anúncio inválido ou fora do formato numérico.',
    }
  }

  try {
    // 1. Primary Query: Ad with nested creative, campaign and adset
    const fields = [
      'id',
      'name',
      'status',
      'campaign{id,name}',
      'adset{id,name}',
      'creative{id,name,title,body,image_url,thumbnail_url,video_id,effective_object_story_id,object_story_spec,asset_feed_spec}',
    ].join(',')

    const url = `${META_API_BASE}/${cleanAdId}?fields=${fields}&access_token=${encodeURIComponent(accessToken)}`
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    })

    const data = (await res.json().catch(() => null)) as RawMetaAdResponse | null

    if (!res.ok || !data || data.error || !data.id) {
      // 2. Fallback check: if ID is a Campaign or AdSet, query standard object
      const fallbackUrl = `${META_API_BASE}/${cleanAdId}?fields=id,name,status,objective&access_token=${encodeURIComponent(accessToken)}`
      const fallbackRes = await fetch(fallbackUrl, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      })
      const fallbackData = (await fallbackRes.json().catch(() => null)) as RawMetaAdResponse | null

      if (fallbackRes.ok && fallbackData?.id && !fallbackData.error) {
        return {
          success: true,
          ad_source_id: cleanAdId,
          ad_name: fallbackData.name || null,
          campaign_name: fallbackData.name || null,
          adset_name: null,
          ad_status: fallbackData.status || null,
          creative_id: null,
          creative_image_url: null,
          creative_thumbnail_url: null,
          creative_type: 'unknown',
          headline: null,
          body: null,
          source_url: null,
        }
      }

      return {
        success: false,
        ad_source_id: cleanAdId,
        ad_name: null,
        campaign_name: null,
        adset_name: null,
        ad_status: null,
        creative_id: null,
        creative_image_url: null,
        creative_thumbnail_url: null,
        creative_type: 'unknown',
        headline: null,
        body: null,
        source_url: null,
        raw_error: data?.error?.message || `Meta API error: ${res.status}`,
      }
    }

    const creative = data.creative || {}
    let creativeType: CreativeType = 'image'
    let imageUrl: string | null = null
    let thumbnailUrl: string | null = null
    let headline: string | null = creative.title || null
    let body: string | null = creative.body || null
    let sourceUrl: string | null = null

    // Determine creative type & extract media URLs
    const objectStory = creative.object_story_spec
    const assetFeed = creative.asset_feed_spec

    // Check Video
    if (creative.video_id || objectStory?.video_data?.image_url || assetFeed?.videos?.length) {
      creativeType = 'video'
      thumbnailUrl =
        creative.thumbnail_url ||
        objectStory?.video_data?.image_url ||
        assetFeed?.videos?.[0]?.thumbnail_url ||
        null
      if (objectStory?.video_data?.message) body = body || objectStory.video_data.message
      if (objectStory?.video_data?.title) headline = headline || objectStory.video_data.title
    }

    // Check Carousel
    const childAttachments = objectStory?.link_data?.child_attachments
    if (childAttachments && Array.isArray(childAttachments) && childAttachments.length > 1) {
      creativeType = 'carousel'
      imageUrl = childAttachments[0]?.picture || null
      sourceUrl = childAttachments[0]?.link || null
      if (childAttachments[0]?.name) headline = headline || childAttachments[0].name
    }

    // Check Dynamic Creative (Advantage+)
    if (assetFeed) {
      creativeType = 'dynamic'
      if (!imageUrl && assetFeed.images && assetFeed.images.length > 0) {
        imageUrl = assetFeed.images[0]?.url || null
      }
      if (!headline && assetFeed.titles && assetFeed.titles.length > 0) {
        headline = assetFeed.titles[0]?.text || null
      }
      if (!body && assetFeed.bodies && assetFeed.bodies.length > 0) {
        body = assetFeed.bodies[0]?.text || null
      }
      if (!sourceUrl && assetFeed.link_urls && assetFeed.link_urls.length > 0) {
        sourceUrl = assetFeed.link_urls[0]?.website_url || null
      }
    }

    // Direct Image URLs
    if (!imageUrl) {
      imageUrl =
        creative.image_url ||
        objectStory?.link_data?.picture ||
        objectStory?.photo_data?.url ||
        null
    }

    if (!sourceUrl && objectStory?.link_data?.link) {
      sourceUrl = objectStory.link_data.link
    }
    if (!headline && objectStory?.link_data?.name) {
      headline = objectStory.link_data.name
    }
    if (!body && objectStory?.link_data?.message) {
      body = objectStory.link_data.message
    }
    if (!body && objectStory?.photo_data?.caption) {
      body = objectStory.photo_data.caption
    }

    // Deep resolution for effective_object_story_id (Dark posts / Page posts) if image still missing
    if (!imageUrl && !thumbnailUrl && creative.effective_object_story_id) {
      try {
        const postUrl = `${META_API_BASE}/${creative.effective_object_story_id}?fields=full_picture,picture,attachments{media,subattachments}&access_token=${encodeURIComponent(
          accessToken,
        )}`
        const postRes = await fetch(postUrl, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
        })
        if (postRes.ok) {
          const postData = (await postRes.json().catch(() => null)) as {
            full_picture?: string
            picture?: string
            attachments?: {
              data?: Array<{
                media?: { image?: { src?: string } }
                subattachments?: {
                  data?: Array<{ media?: { image?: { src?: string } } }>
                }
              }>
            }
          } | null

          if (postData) {
            imageUrl =
              postData.full_picture ||
              postData.picture ||
              postData.attachments?.data?.[0]?.media?.image?.src ||
              postData.attachments?.data?.[0]?.subattachments?.data?.[0]?.media?.image?.src ||
              null
          }
        }
      } catch (postErr) {
        console.warn('[meta-ad-creative] effective_object_story_id lookup failed:', postErr)
      }
    }

    // If Video ID exists but no thumbnail extracted, query Video object directly
    const videoId = creative.video_id || objectStory?.video_data?.video_id
    if (!imageUrl && !thumbnailUrl && videoId) {
      try {
        const videoUrl = `${META_API_BASE}/${videoId}?fields=thumbnails{uri,is_preferred}&access_token=${encodeURIComponent(
          accessToken,
        )}`
        const videoRes = await fetch(videoUrl, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
        })
        if (videoRes.ok) {
          const videoData = (await videoRes.json().catch(() => null)) as {
            thumbnails?: {
              data?: Array<{ uri?: string; is_preferred?: boolean }>
            }
          } | null
          const thumbs = videoData?.thumbnails?.data || []
          const preferred = thumbs.find((t) => t.is_preferred)?.uri || thumbs[0]?.uri || null
          if (preferred) thumbnailUrl = preferred
        }
      } catch (vidErr) {
        console.warn('[meta-ad-creative] Video thumbnail lookup failed:', vidErr)
      }
    }

    const resolvedImage = imageUrl || thumbnailUrl || null

    return {
      success: true,
      ad_source_id: cleanAdId,
      ad_name: data.name || creative.name || null,
      campaign_name: data.campaign?.name || null,
      adset_name: data.adset?.name || null,
      ad_status: data.status || null,
      creative_id: creative.id || null,
      creative_image_url: resolvedImage,
      creative_thumbnail_url: thumbnailUrl || imageUrl || null,
      creative_type: creativeType,
      headline,
      body,
      source_url: sourceUrl,
    }
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : 'Erro na requisição à Meta Graph API'
    return {
      success: false,
      ad_source_id: cleanAdId,
      ad_name: null,
      campaign_name: null,
      adset_name: null,
      ad_status: null,
      creative_id: null,
      creative_image_url: null,
      creative_thumbnail_url: null,
      creative_type: 'unknown',
      headline: null,
      body: null,
      source_url: null,
      raw_error: errorMsg,
    }
  }
}

/**
 * Downloads and persists a remote creative preview image into Supabase Storage
 * to safeguard against Meta CDN token expiration.
 */
export async function cacheAdCreativeImage(args: {
  supabase: SupabaseClient
  accountId: string
  adSourceId: string
  remoteUrl: string
}): Promise<{ storagePath: string; publicUrl: string } | null> {
  const { supabase, accountId, adSourceId, remoteUrl } = args
  if (!remoteUrl || !remoteUrl.startsWith('http')) return null

  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 6000)

    const response = await fetch(remoteUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': 'WACRM-Ad-Fetcher/1.0' },
    })
    clearTimeout(timeoutId)

    if (!response.ok) {
      console.warn('[meta-ad-creative] Could not download image bytes for caching:', response.status)
      return null
    }

    const contentType = response.headers.get('content-type') || 'image/jpeg'
    const arrayBuffer = await response.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)

    let extension = 'jpg'
    if (contentType.includes('png')) extension = 'png'
    if (contentType.includes('webp')) extension = 'webp'

    const storagePath = `account-${accountId}/ad-creatives/${adSourceId}-${Date.now()}.${extension}`

    const { error: uploadErr } = await supabase.storage
      .from('property-media')
      .upload(storagePath, buffer, {
        contentType,
        upsert: true,
      })

    if (uploadErr) {
      console.warn('[meta-ad-creative] Failed to save creative to storage bucket:', uploadErr)
      return null
    }

    const { data: publicUrlData } = supabase.storage
      .from('property-media')
      .getPublicUrl(storagePath)

    return {
      storagePath,
      publicUrl: publicUrlData.publicUrl,
    }
  } catch (cacheErr) {
    console.warn('[meta-ad-creative] cacheAdCreativeImage failed gracefully:', cacheErr)
    return null
  }
}
