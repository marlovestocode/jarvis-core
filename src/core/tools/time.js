// get_time: local ISO time with offset, weekday and IANA time zone.
const pad = n => String(n).padStart(2, '0');

function localIso(d) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

const timeTool = {
  name: 'get_time',
  description: 'Get the current local date, time, weekday and time zone.',
  params: { type: 'object', properties: {}, additionalProperties: false },
  async run() {
    const d = new Date();
    const weekday = d.toLocaleDateString('en-US', { weekday: 'long' });
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return `${localIso(d)} ${weekday} (${zone})`;
  },
};

module.exports = { timeTool, localIso };
