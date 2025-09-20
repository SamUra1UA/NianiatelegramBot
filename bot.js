import { createClient } from '@supabase/supabase-js'
import { Telegraf, Markup } from 'telegraf'


console.log('🚀 bot.js стартує')

// ---- dotenv для локальної розробки ----
if (process.env.NODE_ENV !== 'production') {
    try {
        // динамічний імпорт для ESM
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
    },
}

let state = { ...defaultState }

// Завантаження стану з Supabase
async function loadState() {
    try {
        const { data, error } = await supabase
            .from('bot_state')
            .select('state')
            .eq('id', 'polling')
            .maybeSingle()

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
        const { error } = await supabase
            .from('bot_state')
            .upsert(
                [{ id: 'polling', state: state }],
                { onConflict: 'id' }
            )

        if (error) throw error
        console.log('💾 Збережено стан polling у Supabase:', state.lastTimestamps)
    } catch (err) {
        console.warn('⚠️ Не вдалося зберегти стан у Supabase:', err)
    }
}

// ==== Сесії для реєстрації користувачів ====
const sessions = new Map()

// ==== Авторизація по коду ====
bot.start(async (ctx) => {
    const tgId = String(ctx.from.id)

    const { data: notif, error } = await supabase
        .from('telegram_notifications')
        .select('id, user_role, is_active')
        .eq('telegram_id', tgId)
        .maybeSingle()

    if (error) {
        console.error('DB error checking telegram_notifications:', error)
        return ctx.reply('⚠️ Помилка доступу до бази. Спробуйте пізніше.')
    }

    if (notif?.is_active) {
        return ctx.reply(
            '✅ Ви вже підключили сповіщення.\n\nВикористовуйте /settings щоб змінити налаштування.'
        )
    }

    await ctx.reply('Привіт! Введи 5-значний код з особистого кабінету.')
})

// ==== Меню налаштувань ====
bot.command('settings', async (ctx) => {
    const { data: notif } = await supabase.from('telegram_notifications').select('preferences').eq('telegram_id', String(ctx.from.id)).maybeSingle()

    if (!notif) {
        return ctx.reply('⚠️ Ви не підключили сповіщення. Будь ласка, почніть з команди /start.')
    }

    const prefs = notif?.preferences || {
        new_order: true,
        new_babysitter: true,
    }

    await ctx.reply(
        '⚙️ Налаштування сповіщень',
        Markup.inlineKeyboard([
            [Markup.button.callback(`${prefs.new_babysitter ? '✅' : '❌'} Нові няні`, 'toggle_babysitter')],
            [Markup.button.callback(`${prefs.new_order ? '✅' : '❌'} Нові замовлення`, 'toggle_order')],
            [Markup.button.callback('⬅️ Назад', 'close_settings')],
        ])
    )
})

// Крок 1 – введення коду
bot.hears(/^\d{5}$/, async (ctx) => {
    const code = ctx.message.text
    const chatId = ctx.chat.id

    console.log('➡️ Отримано код', code, 'від', chatId)

    const { data: codeRow, error: codeErr } = await supabase
        .from('telegram_codes')
        .select('*')
        .eq('code', code)
        .eq('is_used', false)
        .maybeSingle()

    if (codeErr) {
        console.error('DB err fetching codeRow:', codeErr)
        return ctx.reply('⚠️ Помилка бази даних. Спробуйте пізніше.')
    }
    if (!codeRow) {
        return ctx.reply('❌ Невірний або вже використаний код.')
    }

    const { data: parentRow } = await supabase
        .from('parent')
        .select('contacts_id, id, location')
        .eq('user_id', codeRow.user_id)
        .maybeSingle()

    const { data: babysitterRow } = await supabase
        .from('babysitter')
        .select('contacts_id, id, location')
        .eq('user_id', codeRow.user_id)
        .maybeSingle()

    const role = parentRow ? 'parent' : babysitterRow ? 'babysitter' : null
    const contactsId = parentRow?.contacts_id || babysitterRow?.contacts_id
    const userRefId = parentRow?.id || babysitterRow?.id
    const location = parentRow?.location || babysitterRow?.location

    if (!contactsId || !role) {
        return ctx.reply('❌ Не знайдено ваш профіль.')
    }

    const { data: contact } = await supabase
        .from('contacts')
        .select('phone')
        .eq('id', contactsId)
        .maybeSingle()

    if (!contact?.phone) {
        return ctx.reply('❌ Не знайдено номер телефону у профілі.')
    }

    sessions.set(chatId, {
        userId: codeRow.user_id,
        refId: userRefId,
        expectedPhone: contact.phone,
        role,
        location,
    })

    return ctx.reply(
        `Введіть номер телефону, який вказаний у вашому профілі (…${contact.phone.slice(-4)} для перевірки)`
    )
})

// Крок 2 – введення телефону
bot.hears(/^\+?\d+$/, async (ctx) => {
    const chatId = ctx.chat.id
    const session = sessions.get(chatId)
    if (!session) return

    if (ctx.message.text !== session.expectedPhone) {
        return ctx.reply('❌ Номер не збігається з профілем. Спробуйте ще раз.')
    }

    const { error: upsertErr } = await supabase
        .from('telegram_notifications')
        .upsert(
            [
                {
                    telegram_id: String(ctx.from.id),
                    user_id: session.userId,
                    user_role: session.role,
                    location: session.location,
                    preferences: { new_babysitter: true, new_order: true },
                    is_active: true,
                },
            ],
            { onConflict: 'telegram_id' }
        )

    if (upsertErr) {
        console.error('Помилка upsert telegram_notifications:', upsertErr)
        return ctx.reply('⚠️ Помилка збереження. Спробуйте пізніше.')
    }

    await supabase.from('telegram_codes').update({ is_used: true }).eq('user_id', session.userId)

    await ctx.reply(
        `✅ Ваш Telegram успішно підключено як ${session.role === 'parent' ? 'Батько/Мати' : 'Няня'}!`,
        Markup.inlineKeyboard([[Markup.button.callback('⚙️ Налаштування сповіщень', 'open_settings')]])
    )

    sessions.delete(chatId)
})

// Обробка кнопок
bot.action('open_settings', async (ctx) => {
    await ctx.answerCbQuery()

    const { data: notif } = await supabase.from('telegram_notifications').select('preferences').eq('telegram_id', String(ctx.from.id)).maybeSingle()

    const prefs = notif?.preferences || {
        new_order: true,
        new_babysitter: true,
    }

    await ctx.editMessageText(
        '⚙️ Налаштування сповіщень',
        Markup.inlineKeyboard([
            [Markup.button.callback(`${prefs.new_babysitter ? '✅' : '❌'} Нові няні`, 'toggle_babysitter')],
            [Markup.button.callback(`${prefs.new_order ? '✅' : '❌'} Нові замовлення`, 'toggle_order')],
            [Markup.button.callback('⬅️ Назад', 'close_settings')],
        ])
    )
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

    await ctx.editMessageText(
        '⚙️ Налаштування сповіщень',
        Markup.inlineKeyboard([
            [Markup.button.callback(`${prefs.new_babysitter ? '✅' : '❌'} Нові няні`, 'toggle_babysitter')],
            [Markup.button.callback(`${prefs.new_order ? '✅' : '❌'} Нові замовлення`, 'toggle_order')],
            [Markup.button.callback('⬅️ Назад', 'close_settings')],
        ])
    )
})
// ==== Хендлери нотифікацій (ваша логіка) ====
async function onNewMessage(message) {
    try {
        console.log('=== onNewMessage DEBUG START ===')
        console.log('payload message:', message)

        const { data: chat, error: chatError } = await supabase
            .from('chats')
            .select('parent_id, babysitter_id')
            .eq('id', message.chat_id)
            .maybeSingle()

        if (chatError) {
            console.error('Помилка пошуку чату:', chatError)
            return
        }
        if (!chat) {
            console.warn('⚠️ Чат не знайдено для id:', message.chat_id)
            return
        }

        let receiverUserId = null
        let receiverRole = null

        if (message.sender_role === 'parent') {
            receiverRole = 'babysitter'
            if (!chat.babysitter_id) return
            const { data: babysitterRow } = await supabase.from('babysitter').select('user_id').eq('id', chat.babysitter_id).maybeSingle()
            if (!babysitterRow) return
            receiverUserId = babysitterRow.user_id
        } else {
            receiverRole = 'parent'
            if (!chat.parent_id) return
            const { data: parentRow } = await supabase.from('parent').select('user_id').eq('id', chat.parent_id).maybeSingle()
            if (!parentRow) return
            receiverUserId = parentRow.user_id
        }

        console.log('receiverUserId', receiverUserId, 'receiverRole', receiverRole)

        const { data: notif } = await supabase
            .from('telegram_notifications')
            .select('telegram_id')
            .eq('user_id', receiverUserId)
            .eq('user_role', receiverRole)
            .eq('is_active', true)
            .maybeSingle()

        console.log('notif', notif)

        if (!notif) return

        try {
            await bot.telegram.sendMessage(
                notif.telegram_id,
                `✉️ Нове повідомлення від ${message.sender_role === 'parent' ? 'батьків' : 'няні'}: ${message.text}\n\n[Відкрити чат](https://www.niania24.com/ua/chat/)`,
                { parse_mode: 'Markdown' }
            )

            console.log('✅ Telegram message sent to', notif.telegram_id)
        } catch (err) {
            console.error('❌ Telegram send error:', err)
        }

        console.log('=== onNewMessage DEBUG END ===')
    } catch (err) {
        console.error('onNewMessage handler error:', err)
    }
}

async function onNewBabysitter(babysitter) {
    try {
        console.log('onNewBabysitter', babysitter)

        const { data: parents } = await supabase.from('parent').select('id, location, user_id')

        const targetParents = (parents || []).filter((p) => p.location === babysitter.location)

        for (let p of targetParents) {
            const { data: notif } = await supabase
                .from('telegram_notifications')
                .select('telegram_id, preferences')
                .eq('user_id', p.user_id)
                .eq('user_role', 'parent')
                .maybeSingle()

            if (notif?.preferences?.new_babysitter) {
                await bot.telegram.sendMessage(
                    notif.telegram_id,
                    `👶 У вашому місті з'явилася нова няня: ${babysitter.name}\n\n[Переглянути профіль](https://www.niania24.com/ua/profile/${babysitter.id})`,
                    { parse_mode: 'Markdown' }
                )
            }

        }
    } catch (err) {
        console.error('onNewBabysitter error:', err)
    }
}

async function onNewOrder(order) {
    try {
        console.log('onNewOrder', order)

        const { data: babysitters } = await supabase.from('babysitter').select('id, location, name, user_id')

        const targetSitters = (babysitters || []).filter((b) => b.location === order.location)

        for (let b of targetSitters) {
            const { data: notif } = await supabase
                .from('telegram_notifications')
                .select('telegram_id, preferences')
                .eq('user_id', b.user_id)
                .eq('user_role', 'babysitter')
                .maybeSingle()

            if (notif?.preferences?.new_order) {
                await bot.telegram.sendMessage(
                    notif.telegram_id,
                    `📢 Нове оголошення від батьків у вашому місті: ${order.name}\n\n[Відкрити замовлення](https://www.niania24.com/ua/order/${order.id})`,
                    { parse_mode: 'Markdown' }
                )
            }

        }
    } catch (err) {
        console.error('onNewOrder error:', err)
    }
}

// Пересилання постів із каналу
bot.on('channel_post', async (ctx) => {
    try {
        const post = ctx.channelPost


        const targetChannelId = -1002985277710; // приклад chat_id
        if (post.chat.username !== 'niania24com' && post.chat.id !== targetChannelId) {
            return;
        }
        // Примітка: post.chat.username може не працювати для приватних каналів

        const { data: users, error } = await supabase.from('telegram_notifications').select('telegram_id').eq('is_active', true)

        if (error) {
            console.error('Помилка запиту до бази даних:', error)
            return
        }

        if (!users || users.length === 0) {
            console.log('Не знайдено активних користувачів для пересилання.')
            return
        }

        for (const user of users) {
            try {
                // Перевірка на існування telegram_id перед відправкою
                if (user.telegram_id) {
                    await bot.telegram.forwardMessage(user.telegram_id, post.chat.id, post.message_id)
                }
            } catch (err) {
                console.error(`Помилка forwardMessage до ${user.telegram_id}:`, err)
            }
        }
    } catch (err) {
        console.error('channel_post handler error:', err)
    }
})

// ==== Ручна команда для перевірки ====
bot.command('testnotify', async (ctx) => {
    try {
        await bot.telegram.sendMessage(ctx.from.id, '✅ Тестове повідомлення від бота')
        console.log('✅ testnotify sent to', ctx.from.id)
    } catch (err) {
        console.error(err)
        await ctx.reply('❌ Не вдалось надіслати тестове повідомлення')
    }
})


// ==== Polling ====
async function pollTableOnce(table, handler) {
    try {
        const last = state.lastTimestamps[table] || defaultState.lastTimestamps[table]
        console.log(`🔎 Polling ${table} з last = ${last}`)

        const { data, error } = await supabase
            .from(table)
            .select('*')
            .gt('created_at', last)
            .order('created_at', { ascending: true })
            .limit(200)

        if (error) {
            console.error(`❌ Помилка опиту ${table}:`, error)
            return
        }

        console.log(`📊 Отримано ${data?.length || 0} нових рядків із ${table}`)

        for (const row of data || []) {
            console.log(`➡️ Обробка рядка ${table}:`, row)
            await handler(row)
            state.lastTimestamps[table] = row.created_at
        }

        if (data?.length) {
            console.log(`✅ Оновлено lastTimestamps[${table}] = ${state.lastTimestamps[table]}`)
            await saveState()
        }
    } catch (err) {
        console.error('pollTableOnce error:', err)
    }
}


function startPolling() {
    console.log('⏱️ Запускаю polling only режим')
    setInterval(async () => {
        console.log('⏱️ Polling messages стартує', new Date().toISOString())
        await pollTableOnce('messages', onNewMessage)
    }, 10000)

    setInterval(async () => {
        console.log('⏱️ Polling babysitter стартує', new Date().toISOString())
        await pollTableOnce('babysitter', onNewBabysitter)
    }, 60000)

    setInterval(async () => {
        console.log('⏱️ Polling order стартує', new Date().toISOString())
        await pollTableOnce('order', onNewOrder)
    }, 60000)

}

// ==== Bot commands ====

bot.command('testnotify', (ctx) => ctx.reply('🔔 Тестове повідомлення'))

async function main() {
    console.log('⏱️ Стартую bot + polling паралельно')

    await loadState() // завантажуємо стан із Supabase перед polling

    // Telegram
    bot.launch().then(() => console.log('✅ Telegram бот запущено'))

    // Supabase polling
    startPolling()
}

main()

process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))