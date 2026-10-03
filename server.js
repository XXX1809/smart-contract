const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const session = require('express-session');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error("Ошибка: Не заданы SUPABASE_URL или SUPABASE_ANON_KEY в файле .env!");
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.set('view engine', 'ejs');

// Настройка сессий
app.use(session({
    secret: 'ai_assistant_secret_key',
    resave: false,
    saveUninitialized: false
}));

// Передаем данные пользователя во все шаблоны
app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    next();
});

// Главная переадресация
app.get('/', (req, res) => {
    res.redirect('/applications');
});

// --- АВТОРИЗАЦИЯ И РЕГИСТРАЦИЯ ---

// Страница входа
app.get('/login', (req, res) => {
    res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;

        req.session.user = data.user;
        res.redirect('/applications');
    } catch (err) {
        res.render('login', { error: 'Ошибка входа: ' + err.message });
    }
});

// Страница регистрации
app.get('/register', (req, res) => {
    res.render('register', { error: null });
});

app.post('/register', async (req, res) => {
    const { email, password } = req.body;
    try {
        const { data, error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;

        // Создаем профиль в таблице profiles, если нужно
        if (data.user) {
            await supabase.from('profiles').insert([{ id: data.user.id, email: email }]);
        }

        res.render('login', { error: null, success: 'Регистрация успешна! Теперь войдите в систему.' });
    } catch (err) {
        res.render('register', { error: 'Ошибка регистрации: ' + err.message });
    }
});

// Выход
app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/login');
    });
});


// --- ПРОГРАММЫ И ПОДАЧА ЗАЯВОК ---

app.get('/applications', async (req, res) => {
    try {
        const { data: programs, error } = await supabase.from('programs').select('*');
        if (error) throw error;

        res.render('applications', { programs, error: null, success: null });
    } catch (err) {
        res.status(500).send("Ошибка загрузки программ: " + err.message);
    }
});

app.post('/applications', async (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }

    const { program_id } = req.body;
    const user_id = req.session.user.id; // Берем ID из сессии автоматически!

    try {
        const { data: program, error: progError } = await supabase
            .from('programs')
            .select('*')
            .eq('id', program_id)
            .single();

        if (progError || !program) {
            return res.status(400).send("Программа не найдена.");
        }

        const { data: programs } = await supabase.from('programs').select('*');

        if (program.available_spots <= 0) {
            return res.render('applications', { 
                programs, 
                error: 'Ошибка: На эту программу закончились свободные места!', 
                success: null 
            });
        }

        const { data: existingApp } = await supabase
            .from('applications')
            .select('*')
            .eq('user_id', user_id)
            .eq('program_id', program_id)
            .single();

        if (existingApp) {
            return res.render('applications', { 
                programs, 
                error: 'Вы уже подали заявку на эту образовательную программу.', 
                success: null 
            });
        }

        const { error: insertError } = await supabase
            .from('applications')
            .insert([{ user_id, program_id }]);

        if (insertError) throw insertError;

        // Автоматически уменьшаем количество мест
        await supabase
            .from('programs')
            .update({ available_spots: program.available_spots - 1 })
            .eq('id', program_id);

        // Обновляем список программ
        const { data: updatedPrograms } = await supabase.from('programs').select('*');

        res.render('applications', { 
            programs: updatedPrograms, 
            error: null, 
            success: 'Ваша заявка успешно отправлена!' 
        });

    } catch (err) {
        res.status(500).send("Ошибка сервера: " + err.message);
    }
});


// --- ЛИЧНЫЙ КАБИНЕТ (Мои заявки) ---
app.get('/dashboard', async (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }

    try {
        const user_id = req.session.user.id;
        
        // Получаем заявки пользователя вместе с информацией о программах
        const { data: applications, error } = await supabase
            .from('applications')
            .select('*, programs(title, description)')
            .eq('user_id', user_id);

        if (error) throw error;

        res.render('dashboard', { applications });
    } catch (err) {
        res.status(500).send("Ошибка загрузки личного кабинета: " + err.message);
    }
});
// --- АДМИН-ПАНЕЛЬ ---
// --- АДМИН-ПАНЕЛЬ ---
app.get('/admin', async (req, res) => {
    // Проверяем, авторизован ли пользователь вообще
    if (!req.session.user) {
        return res.redirect('/login');
    }

    try {
        // 1. Проверяем роль текущего пользователя в таблице profiles
        const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('role')
            .eq('id', req.session.user.id)
            .single();

        // 2. Если пользователь не администратор — блокируем доступ
        if (profileError || !profile || profile.role !== 'admin') {
            return res.status(403).send("Доступ запрещен. У вас нет прав администратора.");
        }

        // 3. Если он админ — загружаем все заявки
        const { data: applications, error } = await supabase
            .from('applications')
            .select(`
                id,
                status,
                created_at,
                programs ( title ),
                profiles ( email )
            `)
            .order('created_at', { ascending: false });

        if (error) throw error;

        res.render('admin', { applications, error: null, success: null });
    } catch (err) {
        res.status(500).send("Ошибка загрузки панели администратора: " + err.message);
    }
});

// Изменение статуса заявки
app.post('/admin/applications/:id/status', async (req, res) => {
    const appId = req.params.id;
    const { status } = req.body; // 'Одобрено' или 'Отклонено'

    try {
        const { error } = await supabase
            .from('applications')
            .update({ status: status })
            .eq('id', appId);

        if (error) throw error;
        res.redirect('/admin');
    } catch (err) {
        res.status(500).send("Ошибка обновления статуса: " + err.message);
    }
});
// --- ЛИЧНЫЙ КАБИНЕТ АБИТУРИЕНТА ---
app.get('/dashboard', async (req, res) => {
    // Проверяем, авторизован ли пользователь
    if (!req.session.user) {
        return res.redirect('/login');
    }

    try {
        const userId = req.session.user.id;

        // Получаем заявки текущего пользователя вместе с названиями программ
        const { data: applications, error } = await supabase
            .from('applications')
            .select(`
                id,
                status,
                created_at,
                programs ( title )
            `)
            .eq('user_id', userId)
            .order('created_at', { ascending: false });

        if (error) throw error;

        res.render('dashboard', { 
            user: req.session.user, 
            applications: applications || [] 
        });
    } catch (err) {
        res.status(500).send("Ошибка загрузки личного кабинета: " + err.message);
    }
});
app.listen(port, () => {
    console.log(`Сервер запущен: http://localhost:${port}/applications`);
});