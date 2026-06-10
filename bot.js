import { createClient } from '@supabase/supabase-js'
import { Telegraf, Markup } from 'telegraf'
import express from 'express'

console.log('🚀 bot.js стартує')

// ---- dotenv для локальної розробки ----
if (process.env.NODE_ENV !== 'production') {
    try {
        await import('dotenv').then(dotenv => dotenv.config())
        console.log('✅ .env завантажено')
    } catch (err) {
        console.warn('⚠️ dotenv не підключено:', err)
    }
}

// ---- Перевірка env змінних ----
const BOT_TOKEN = process.env.BOT_TOKEN
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY

if (!BOT_TOKEN || !SUPABASE_URL || !SUPABASE_KEY) {
    console.error('❌ Не задано BOT_TOKEN / SUPABASE_URL / SUPABASE_KEY')
    process.exit(1)
}

// ---- Ініціалізація клієнтів ----
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
const bot = new Telegraf(BOT_TOKEN)

const defaultState = {
    lastTimestamps: {
        messages: '1970-01-01T00:00:00.000Z',
        babysitter: '1970-01-01T00:00:00.000Z',
        order: '1970-01-01T00:00:00.000Z',
        chats: '1970-01-01T00:00:00.000Z',
        articles: new Date().toISOString(), // Тільки нові статті від моменту першого запуску
    },
}

let state = { ...defaultState }

// Завантаження стану з Supabase
async function loadState() {
    try {
        const { data, error } = await supabase.from('bot_state').select('state').eq('id', 'polling').maybeSingle()
        if (error) throw error
        if (data?.state) {
            state.lastTimestamps = { ...defaultState.lastTimestamps, ...data.state.lastTimestamps }
            console.log('🔁 Завантажено стан polling з Supabase:', state.lastTimestamps)
        } else {
            console.log('📂 Стану немає, використовую defaultState')
        }
    } catch (err) {
        console.warn('⚠️ Не вдалося завантажити стан з Supabase:', err)
        state = { ...defaultState }
    }
}

// Збереження стану у Supabase
async function saveState() {
    try {
        const { error } = await supabase.from('bot_state').upsert([{ id: 'polling', state: state }], { onConflict: 'id' })
        if (error) throw error
    } catch (err) {
        console.warn('⚠️ Не вдалося зберегти стан у Supabase:', err)
    }
}

// ========================================================
// --- ФУНКЦІЯ ДЛЯ ВІДПРАВКИ PUSH-СПОВІЩЕНЬ В ДОДАТОК ---
// ========================================================
async function sendExpoPushes(tokens, title, body, dataPayload = {}) {
    if (!tokens || tokens.length === 0) return;

    const messages = tokens.map(token => ({
        to: token,
        sound: 'default',
        title: title,
        body: body,
        data: dataPayload,
    }));

    try {
        const res = await fetch('https://exp.host/--/api/v2/push/send', {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(messages),
        });
        const data = await res.json();
        console.log(`📱 Expo Push відправлено на ${tokens.length} пристроїв`);
    } catch (err) {
        console.error('❌ Помилка відправки Expo Push:', err);
    }
}

// ========================================================
// --- ФУНКЦІЯ ДЛЯ ВІДПРАВКИ PUSH-СПОВІЩЕНЬ З РЕЗУЛЬТАТАМИ ---
// ========================================================
async function sendExpoPushesWithResult(tokensObj, title, body, dataPayload = {}) {
    if (!tokensObj || tokensObj.length === 0) return { success: [], failed: [] };

    const messages = tokensObj.map(t => ({
        to: t.token,
        sound: 'default',
        title: title,
        body: body,
        data: dataPayload,
    }));

    const results = { success: [], failed: tokensObj.map(t => t.user_id) };

    try {
        const res = await fetch('https://exp.host/--/api/v2/push/send', {
            method: 'POST',
            headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify(messages),
        });
        const data = await res.json();

        if (data?.data) {
            results.failed = [];
            data.data.forEach((ticket, i) => {
                if (ticket.status === 'ok') results.success.push(tokensObj[i].user_id);
                else results.failed.push(tokensObj[i].user_id);
            });
        }
    } catch (err) {
        console.error('❌ Помилка відправки Expo Push:', err);
    }
    return results;
}

// ==== Сесії для реєстрації користувачів (Телеграм) ====
const sessions = new Map()

bot.start(async (ctx) => {
    const tgId = String(ctx.from.id)
    const { data: notif, error } = await supabase.from('telegram_notifications').select('id, user_role, is_active').eq('telegram_id', tgId).maybeSingle()
    if (error) return ctx.reply('⚠️ Помилка доступу до бази. Спробуйте пізніше.')
    if (notif?.is_active) return ctx.reply('✅ Ви вже підключили сповіщення.\n\nВикористовуйте /settings щоб змінити налаштування.')
    await ctx.reply('Привіт! Введи 5-значний код з особистого кабінету.')
})

bot.command('settings', async (ctx) => {
    const { data: notif } = await supabase.from('telegram_notifications').select('preferences').eq('telegram_id', String(ctx.from.id)).maybeSingle()
    if (!notif) return ctx.reply('⚠️ Ви не підключили сповіщення. Будь ласка, почніть з команди /start.')
    const prefs = notif?.preferences || { new_order: true, new_babysitter: true }
    await ctx.reply(
        '⚙️ Налаштування сповіщень',
        Markup.inlineKeyboard([
            [Markup.button.callback(`${prefs.new_babysitter ? '✅' : '❌'} Нові няні`, 'toggle_babysitter')],
            [Markup.button.callback(`${prefs.new_order ? '✅' : '❌'} Нові замовлення`, 'toggle_order')],
            [Markup.button.callback('⬅️ Назад', 'close_settings')],
        ])
    )
})

bot.hears(/^\d{5}$/, async (ctx) => {
    const code = ctx.message.text
    const chatId = ctx.chat.id
    const { data: codeRow, error: codeErr } = await supabase.from('telegram_codes').select('*').eq('code', code).eq('is_used', false).maybeSingle()

    if (codeErr || !codeRow) return ctx.reply('❌ Невірний або вже використаний код.')

    const { data: parentRow } = await supabase.from('parent').select('contacts_id, id, location').eq('user_id', codeRow.user_id).maybeSingle()
    const { data: babysitterRow } = await supabase.from('babysitter').select('contacts_id, id, location').eq('user_id', codeRow.user_id).maybeSingle()

    const role = parentRow ? 'parent' : babysitterRow ? 'babysitter' : null
    const contactsId = parentRow?.contacts_id || babysitterRow?.contacts_id
    const userRefId = parentRow?.id || babysitterRow?.id
    const location = parentRow?.location || babysitterRow?.location

    if (!contactsId || !role) return ctx.reply('❌ Не знайдено ваш профіль.')

    const { data: contact } = await supabase.from('contacts').select('phone').eq('id', contactsId).maybeSingle()
    if (!contact?.phone) return ctx.reply('❌ Не знайдено номер телефону у профілі.')

    sessions.set(chatId, { userId: codeRow.user_id, refId: userRefId, expectedPhone: contact.phone, role, location })
    return ctx.reply(`Введіть номер телефону, який вказаний у вашому профілі (…${contact.phone.slice(-4)} для перевірки)`)
})

bot.hears(/^\+?\d+$/, async (ctx) => {
    const chatId = ctx.chat.id
    const session = sessions.get(chatId)
    if (!session) return

    if (ctx.message.text !== session.expectedPhone) return ctx.reply('❌ Номер не збігається з профілем. Спробуйте ще раз.')

    const { error: upsertErr } = await supabase.from('telegram_notifications').upsert(
        [{ telegram_id: String(ctx.from.id), user_id: session.userId, user_role: session.role, location: session.location, preferences: { new_babysitter: true, new_order: true }, is_active: true }],
        { onConflict: 'telegram_id' }
    )

    if (upsertErr) return ctx.reply('⚠️ Помилка збереження. Спробуйте пізніше.')
    await supabase.from('telegram_codes').update({ is_used: true }).eq('user_id', session.userId)
    await ctx.reply(`✅ Ваш Telegram успішно підключено!`, Markup.inlineKeyboard([[Markup.button.callback('⚙️ Налаштування сповіщень', 'open_settings')]]))
    sessions.delete(chatId)
})

bot.action('open_settings', async (ctx) => {
    await ctx.answerCbQuery()
    const { data: notif } = await supabase.from('telegram_notifications').select('preferences').eq('telegram_id', String(ctx.from.id)).maybeSingle()
    const prefs = notif?.preferences || { new_order: true, new_babysitter: true }
    await ctx.editMessageText('⚙️ Налаштування сповіщень', Markup.inlineKeyboard([
        [Markup.button.callback(`${prefs.new_babysitter ? '✅' : '❌'} Нові няні`, 'toggle_babysitter')],
        [Markup.button.callback(`${prefs.new_order ? '✅' : '❌'} Нові замовлення`, 'toggle_order')],
        [Markup.button.callback('⬅️ Назад', 'close_settings')],
    ]))
})

bot.action('close_settings', async (ctx) => {
    await ctx.answerCbQuery()
    await ctx.editMessageText('Меню закрито.')
})

bot.action(/toggle_(.+)/, async (ctx) => {
    await ctx.answerCbQuery()
    const type = ctx.match[1]
    const { data: notif } = await supabase.from('telegram_notifications').select('preferences').eq('telegram_id', String(ctx.from.id)).maybeSingle()
    if (!notif) return ctx.reply('⚠️ Налаштування не знайдено.')

    const prefs = notif.preferences || { new_order: true, new_babysitter: true }
    prefs[`new_${type}`] = !prefs[`new_${type}`]
    await supabase.from('telegram_notifications').update({ preferences: prefs }).eq('telegram_id', String(ctx.from.id))

    await ctx.editMessageText('⚙️ Налаштування сповіщень', Markup.inlineKeyboard([
        [Markup.button.callback(`${prefs.new_babysitter ? '✅' : '❌'} Нові няні`, 'toggle_babysitter')],
        [Markup.button.callback(`${prefs.new_order ? '✅' : '❌'} Нові замовлення`, 'toggle_order')],
        [Markup.button.callback('⬅️ Назад', 'close_settings')],
    ]))
})

// ========================================================
// --- ХЕНДЛЕРИ 4 ТИПІВ СПОВІЩЕНЬ (TELEGRAM + EXPO APP) ---
// ========================================================

// ТИП 3: НОВЕ ПОВІДОМЛЕННЯ В ЧАТІ
async function onNewMessage(message) {
    try {
        const { data: chat } = await supabase.from('chats').select('parent_id, babysitter_id').eq('id', message.chat_id).maybeSingle()
        if (!chat) return

        let receiverUserId = null
        let receiverRole = null

        if (message.sender_role === 'parent') {
            receiverRole = 'babysitter'
            const { data: babysitterRow } = await supabase.from('babysitter').select('user_id').eq('id', chat.babysitter_id).maybeSingle()
            if (babysitterRow) receiverUserId = babysitterRow.user_id
        } else {
            receiverRole = 'parent'
            const { data: parentRow } = await supabase.from('parent').select('user_id').eq('id', chat.parent_id).maybeSingle()
            if (parentRow) receiverUserId = parentRow.user_id
        }

        if (!receiverUserId) return

        // 1. Відправка в Telegram
        const { data: notif } = await supabase.from('telegram_notifications').select('telegram_id').eq('user_id', receiverUserId).eq('user_role', receiverRole).eq('is_active', true).maybeSingle()
        if (notif) {
            await bot.telegram.sendMessage(notif.telegram_id, `✉️ Нове повідомлення від ${message.sender_role === 'parent' ? 'батьків' : 'няні'}: ${message.text}\n\n[Відкрити чат](https://www.niania24.com/ua/chat/)`, { parse_mode: 'Markdown' }).catch(console.error)
        }

        // 2. Відправка в Мобільний додаток (Expo Push)
        const { data: pushTokens } = await supabase.from('expo_tokens').select('token').eq('user_id', receiverUserId);
        if (pushTokens && pushTokens.length > 0) {
            await sendExpoPushes(
                pushTokens.map(t => t.token),
                `Повідомлення від ${message.sender_role === 'parent' ? 'батьків' : 'няні'}`,
                message.text,
                { type: 'message', chat_id: message.chat_id }
            );
        }
    } catch (err) { console.error('onNewMessage error:', err) }
}

// ТИП 1: НОВІ НЯНІ У МІСТІ (ДЛЯ БАТЬКІВ)
async function onNewBabysitter(babysitter) {
    try {
        const { data: parents } = await supabase.from('parent').select('id, location, user_id')
        const targetParents = (parents || []).filter((p) => p.location === babysitter.location)

        // 1. Відправка в Telegram
        for (let p of targetParents) {
            const { data: notif } = await supabase.from('telegram_notifications').select('telegram_id, preferences').eq('user_id', p.user_id).eq('user_role', 'parent').maybeSingle()
            if (notif?.preferences?.new_babysitter) {
                await bot.telegram.sendMessage(notif.telegram_id, `👶 У вашому місті з'явилася нова няня: ${babysitter.name}\n\n[Переглянути профіль](https://www.niania24.com/ua/profile/${babysitter.id})`, { parse_mode: 'Markdown' }).catch(console.error)
            }
        }

        // 2. Відправка в Мобільний додаток (Expo Push)
        const parentIds = targetParents.map(p => p.user_id);
        if (parentIds.length > 0) {
            const { data: pushTokens } = await supabase.from('expo_tokens').select('token').in('user_id', parentIds);
            if (pushTokens && pushTokens.length > 0) {
                await sendExpoPushes(
                    pushTokens.map(t => t.token),
                    'Нова няня у вашому місті! 🎉',
                    `Зареєструвалася нова няня: ${babysitter.name}.`,
                    { type: 'babysitter', id: babysitter.id }
                );
            }
        }
    } catch (err) { console.error('onNewBabysitter error:', err) }
}

// ТИП 2: НОВІ ОГОЛОШЕННЯ У МІСТІ (ДЛЯ НЯНЬ)
async function onNewOrder(order) {
    if (order.status !== 'active' && order.status !== 'approved' && order.status !== 'published') return;

    try {
        const { data: babysitters } = await supabase.from('babysitter').select('id, location, name, user_id')
        const targetSitters = (babysitters || []).filter((b) => b.location === order.location)

        const sitterIds = targetSitters.map(b => b.user_id);
        if (sitterIds.length === 0) return;

        const { data: pushTokens } = await supabase.from('expo_tokens').select('token, user_id').in('user_id', sitterIds);
        const { data: telegramPrefs } = await supabase.from('telegram_notifications').select('telegram_id, user_id, preferences').in('user_id', sitterIds).eq('user_role', 'babysitter').eq('is_active', true);

        let pushResults = { success: [], failed: sitterIds };
        if (pushTokens && pushTokens.length > 0) {
            pushResults = await sendExpoPushesWithResult(
                pushTokens,
                'Нове замовлення! 👶',
                `У вашому місті з'явилося нове оголошення: ${order.name || order.title || 'Нове замовлення'}.`,
                { type: 'order', id: order.id }
            );
        }

        for (let b of targetSitters) {
            const uniqueKey = `new_order:${order.id}:telegram:${b.user_id}`;
            const { data: existingLog } = await supabase.from('notification_logs').select('id').eq('unique_key', uniqueKey).maybeSingle();
            if (existingLog) continue;

            let sentPush = pushResults.success.includes(b.user_id);
            let tgPref = (telegramPrefs || []).find(t => t.user_id === b.user_id);
            let sentTg = false;
            let tgError = null;

            if (!sentPush && tgPref && tgPref.preferences?.new_order) {
                try {
                    await bot.telegram.sendMessage(
                        tgPref.telegram_id,
                        `👶 Нове оголошення у вашому місті\n\nМісто: ${order.location}\nВік дитини: ${order.child_age || '-'}\nГрафік: ${order.schedule || '-'}\nОплата: ${order.price || '-'}\n\n[Переглянути оголошення](https://www.niania24.com/ua/order/${order.id})`,
                        { parse_mode: 'Markdown' }
                    );
                    sentTg = true;
                } catch (e) {
                    console.error('Telegram send error:', e);
                    tgError = e.message;
                }
            }

            await supabase.from('notification_logs').insert({
                notification_type: 'new_order',
                entity_id: order.id,
                user_id: b.user_id,
                channel: sentPush ? 'app_push' : (sentTg ? 'telegram' : 'none'),
                status: sentPush || sentTg ? 'sent' : 'failed',
                error_message: tgError || (!sentPush ? 'Push failed or no token' : null),
                unique_key: uniqueKey
            }).catch(() => {});
        }
    } catch (err) { console.error('onNewOrder error:', err) }
}

// ТИП 4: СТВОРЕНО НОВИЙ ЧАТ
async function onNewChat(chat) {
    try {
        const { data: parent } = await supabase.from('parent').select('user_id, name').eq('id', chat.parent_id).maybeSingle();
        const { data: babysitter } = await supabase.from('babysitter').select('user_id, name').eq('id', chat.babysitter_id).maybeSingle();

        if (parent && babysitter) {
            // Повідомляємо няню про новий чат від батьків
            const { data: bTokens } = await supabase.from('expo_tokens').select('token').eq('user_id', babysitter.user_id);
            if (bTokens && bTokens.length > 0) {
                await sendExpoPushes(
                    bTokens.map(t => t.token),
                    'Новий чат! 💬',
                    `${parent.name || 'Батьки'} хоче розпочати з вами чат.`,
                    { type: 'chat', chat_id: chat.id }
                );
            }

            // Повідомляємо батьків
            const { data: pTokens } = await supabase.from('expo_tokens').select('token').eq('user_id', parent.user_id);
            if (pTokens && pTokens.length > 0) {
                await sendExpoPushes(
                    pTokens.map(t => t.token),
                    'Новий чат! 💬',
                    `Створено чат з нянею ${babysitter.name || ''}.`,
                    { type: 'chat', chat_id: chat.id }
                );
            }
        }
    } catch (err) { console.error('onNewChat error:', err) }
}

// ТИП 5: НОВА СТАТТЯ В БЛОЗІ
async function onNewArticle(article) {
    if (!article || !article.title) return; // У таблиці articles немає поля status, тому просто перевіряємо наявність заголовку

    // Безпечна перевірка: не розсилати сповіщення для статей, старших за 24 години
    const articleDate = new Date(article.created_at);
    const now = new Date();
    const diffHours = (now - articleDate) / (1000 * 60 * 60);
    if (diffHours > 24) {
        return;
    }

    try {
        const { data: pushTokens } = await supabase.from('expo_tokens').select('token, user_id');
        const { data: telegramPrefs } = await supabase.from('telegram_notifications').select('telegram_id, user_id').eq('is_active', true);

        const allUserIds = [...new Set([...(pushTokens||[]).map(t => t.user_id), ...(telegramPrefs||[]).map(t => t.user_id)])];

        let pushResults = { success: [], failed: allUserIds };
        if (pushTokens && pushTokens.length > 0) {
            pushResults = await sendExpoPushesWithResult(
                pushTokens,
                'Нова стаття в блозі 📰',
                article.title,
                { type: 'blog', id: article.id }
            );
        }

        for (let uid of allUserIds) {
            const uniqueKey = `blog_article:${article.id}:telegram:${uid}`;
            const { data: existingLog } = await supabase.from('notification_logs').select('id').eq('unique_key', uniqueKey).maybeSingle();
            if (existingLog) continue;

            let sentPush = pushResults.success.includes(uid);
            let tgPref = (telegramPrefs || []).find(t => t.user_id === uid);
            let sentTg = false;
            let tgError = null;

            if (!sentPush && tgPref) {
                try {
                    let msg = `📰 *Нова стаття в блозі*\n\n*${article.title}*\n`;
                    if (article.description) msg += `\n${article.description}\n`;
                    msg += `\n[Читати](https://www.niania24.com/ua/blog/${article.id})`;

                    await bot.telegram.sendMessage(tgPref.telegram_id, msg, { parse_mode: 'Markdown' });
                    sentTg = true;
                } catch (e) {
                    console.error('Telegram send error for blog:', e);
                    tgError = e.message;
                }
            }

            await supabase.from('notification_logs').insert({
                notification_type: 'blog_article',
                entity_id: article.id,
                user_id: uid,
                channel: sentPush ? 'app_push' : (sentTg ? 'telegram' : 'none'),
                status: sentPush || sentTg ? 'sent' : 'failed',
                error_message: tgError || (!sentPush ? 'Push failed or no token' : null),
                unique_key: uniqueKey
            }).catch(() => {});
        }
    } catch (err) { console.error('onNewArticle error:', err) }
}

// Пересилання постів із каналу (Залишено без змін)
bot.on('channel_post', async (ctx) => {
    try {
        const post = ctx.channelPost
        const targetChannelId = -1002985277710;
        if (post.chat.username !== 'niania24com' && post.chat.id !== targetChannelId) return;

        const { data: users, error } = await supabase.from('telegram_notifications').select('telegram_id').eq('is_active', true)
        if (error || !users || users.length === 0) return;

        for (const user of users) {
            if (user.telegram_id) {
                await bot.telegram.forwardMessage(user.telegram_id, post.chat.id, post.message_id).catch(console.error)
            }
        }
    } catch (err) { console.error('channel_post handler error:', err) }
})

bot.command('testnotify', async (ctx) => {
    try {
        await bot.telegram.sendMessage(ctx.from.id, '✅ Тестове повідомлення від бота')
    } catch (err) {
        await ctx.reply('❌ Не вдалось надіслати тестове повідомлення')
    }
})

// ==== Polling (Опитування бази даних) ====
async function pollTableOnce(table, handler, extraFilter = null) {
    try {
        const last = state.lastTimestamps[table] || defaultState.lastTimestamps[table]
        let query = supabase.from(table).select('*').gt('created_at', last).order('created_at', { ascending: true }).limit(200)

        if (extraFilter) {
            query = extraFilter(query)
        }

        const { data, error } = await query

        if (error) return console.error(`❌ Помилка опиту ${table}:`, error)

        for (const row of data || []) {
            await handler(row)
            state.lastTimestamps[table] = row.created_at
        }

        if (data?.length) await saveState()
    } catch (err) {
        console.error('pollTableOnce error:', err)
    }
}

function startPolling() {
    console.log('⏱️ Запускаю polling режим')
    setInterval(async () => await pollTableOnce('messages', onNewMessage), 10000)
    setInterval(async () => await pollTableOnce('babysitter', onNewBabysitter, (q) => q.eq('is_verified', true)), 60000)
    setInterval(async () => await pollTableOnce('order', onNewOrder), 60000)
    setInterval(async () => await pollTableOnce('chats', onNewChat), 15000) // ДОДАНО: опитування нових чатів
    setInterval(async () => await pollTableOnce('articles', onNewArticle), 60000) // ДОДАНО: опитування нових статей блогу
}

async function main() {
    console.log('⏱️ Стартую bot + polling паралельно')
    await loadState()
    bot.launch().then(() => console.log('✅ Telegram бот запущено'))
    startPolling()
}

main()

const app = express()
app.get('/', (req, res) => res.send('✅ OK'))
const PORT = process.env.PORT || 8000
app.listen(PORT, () => console.log(`Health check listening on ${PORT}`))

process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))