export async function onRequest(context) {
  const { env, request } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*' } });
  }

  const apiKey    = env.YOUTUBE_API_KEY;
  const channelId = env.YOUTUBE_CHANNEL_ID || 'UC_LgpxOvIoHwLENK_6bOHSg';

  if (!apiKey) {
    return Response.json({ error: 'YOUTUBE_API_KEY not configured' }, { status: 500 });
  }

  try {
    // Channel stats (subscribers, views, video count)
    const statsRes = await fetch(
      `https://www.googleapis.com/youtube/v3/channels?part=statistics,snippet&id=${channelId}&key=${apiKey}`
    );
    const statsData = await statsRes.json();

    if (statsData.error) throw new Error(statsData.error.message);

    const channel = statsData.items?.[0];
    if (!channel) throw new Error('Channel not found');

    const stats = channel.statistics;

    // Latest videos (for recent activity)
    const videosRes = await fetch(
      `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&maxResults=10&order=date&type=video&key=${apiKey}`
    );
    const videosData = await videosRes.json();
    const recentVideos = (videosData.items || []).map(v => ({
      id:           v.id.videoId,
      title:        v.snippet.title,
      published_at: v.snippet.publishedAt?.slice(0, 10),
      thumbnail:    v.snippet.thumbnails?.default?.url,
    }));

    return Response.json({
      channel_name:  channel.snippet.title,
      subscribers:   parseInt(stats.subscriberCount  || 0),
      total_views:   parseInt(stats.viewCount        || 0),
      video_count:   parseInt(stats.videoCount       || 0),
      recent_videos: recentVideos,
    }, { headers: { 'Access-Control-Allow-Origin': '*' } });

  } catch (err) {
    return Response.json({ error: err.message }, { status: 500, headers: { 'Access-Control-Allow-Origin': '*' } });
  }
}
