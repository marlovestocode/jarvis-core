'use strict';
// Tools that only read state; safe to re-run when a task is resumed after an interruption.
const READ_ONLY = new Set([
  'get_time', 'calculate', 'convert_units', 'date_calc', 'differentiate', 'integrate', 'solve_equation', 'statistics',
  'physics_constant', 'list_timers', 'list_windows', 'media_status', 'find_files', 'file_info', 'folder_size', 'big_files',
  'list_recent_files', 'read_document', 'search_file_text', 'get_system_stats', 'get_weather', 'weather_alerts',
  'news_headlines', 'sports_scores', 'lookup_knowledge', 'web_search', 'read_article', 'jarvis_status', 'self_diagnostics',
  'self_log', 'skills_list', 'music_stats', 'ytm_library', 'browser_tabs', 'browser_history_search',
  'browser_bookmark_search', 'browser_read_page', 'recall_chats', 'memory_about', 'find_song_by_lyric', 'get_lyrics',
  'analytics_summary',
]);

const isReadOnly = name => READ_ONLY.has(name);

module.exports = { READ_ONLY, isReadOnly };
