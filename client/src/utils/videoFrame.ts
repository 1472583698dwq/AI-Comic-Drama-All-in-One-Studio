/** 把视频停在结尾前一帧，导出成 JPEG。跨域视频需要服务端允许读取画面。 */
export async function grabLastVideoFrame(src: string): Promise<Blob> {
  const video = document.createElement('video');
  video.crossOrigin = 'anonymous';
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = src;
  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve();
    video.onerror = () => reject(new Error('上一镜视频无法读取'));
  });
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  video.currentTime = Math.max(0, duration - 0.08);
  await new Promise<void>((resolve, reject) => {
    video.onseeked = () => resolve();
    video.onerror = () => reject(new Error('无法定位到上一镜尾帧'));
  });
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth || 720;
  canvas.height = video.videoHeight || 1280;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法绘制尾帧');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.86));
  if (!blob) throw new Error('尾帧导出失败');
  return blob;
}
