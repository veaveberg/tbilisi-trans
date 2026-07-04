export type AppLanguage = 'en' | 'ka' | 'ru';
export type UiLanguage = AppLanguage;
export type StopLanguage = 'en' | 'ka';
export type MapLanguage = AppLanguage;
export type LanguageTarget = 'ui' | 'stops' | 'map';

export const DEFAULT_UI_LANGUAGE: UiLanguage = 'en';
export const DEFAULT_STOP_NAMES_LANGUAGE: StopLanguage = 'en';
export const DEFAULT_MAP_LANGUAGE: MapLanguage = 'en';

export const UI_LANGUAGE_STORAGE_KEY = 'uiLanguage';
export const STOP_NAMES_LANGUAGE_STORAGE_KEY = 'stopNamesLanguage';
export const MAP_LANGUAGE_STORAGE_KEY = 'mapLanguage';

export const UI_LANGUAGE_QUERY_PARAM = 'uiLocale';
export const STOP_NAMES_LANGUAGE_QUERY_PARAM = 'stopsLocale';
export const MAP_LANGUAGE_QUERY_PARAM = 'mapLocale';
export const LEGACY_LANGUAGE_STORAGE_KEY = 'language';
export const LEGACY_LANGUAGE_QUERY_PARAM = 'locale';

type StringTable = Record<string, string>;

const STRINGS: Record<AppLanguage, StringTable> = {
    en: {
        appTitle: 'Tbilisi Trans',
        language: 'Language',
        uiLanguage: 'Interface',
        stopNamesLanguage: 'Stop names',
        mapLanguage: 'Map',
        searchPlaceholder: 'Search for places or routes...',
        clear: 'Clear',
        selectStop: 'Select a stop',
        back: 'Back',
        more: 'More',
        edit: 'Edit',
        favorite: 'Favorite',
        unfavorite: 'Unfavorite',
        copyLink: 'Copy link',
        streetScreen: 'Show board',
        close: 'Close',
        minimize: 'Minimize',
        directionsTitle: 'Directions',
        startingPoint: 'Starting point',
        destinationPoint: 'Destination',
        chooseStartingPoint: 'Choose a starting point',
        chooseDestination: 'Choose a destination',
        clearStartingPoint: 'Clear starting point',
        clearDestination: 'Clear destination',
        reverseDirections: 'Reverse directions',
        options: 'Options',
        bus: 'Bus',
        metro: 'Metro',
        cableCar: 'Cable car',
        routePriority: 'Route priority',
        faster: 'Faster',
        lessWalking: 'Less walking',
        lessTransfers: 'Less transfers',
        timeAndDate: 'Time and date',
        tripMode: 'Trip mode',
        departAt: 'Departure',
        arriveBy: 'Arrival',
        leaveNow: 'Leave now',
        now: 'Now',
        tripTime: 'Trip time',
        adjustTime: 'Adjust time',
        earlierTime: 'Earlier time',
        laterTime: 'Later time',
        adjustDate: 'Adjust date',
        previousDay: 'Previous day',
        nextDay: 'Next day',
        chooseDate: 'Choose date',
        previousMonth: 'Previous month',
        nextMonth: 'Next month',
        today: 'today',
        tomorrow: 'tomorrow',
        routeOptionsReady: 'Route options will appear here after the planner is connected.',
        routeOptionsEmpty: 'Select two points to preview route options.',
        directionsFromHere: 'Directions from here',
        directionsToHere: 'Directions to here',
        location: 'Location',
        myLocation: 'My Location',
        rotation: 'Rotation',
        mergeInto: 'Merge into...',
        hubWith: 'Hub with...',
        restoreEnglish: 'Restore English',
        restoreGeorgian: 'Restore Georgian',
        gondolaInfoPlaceholder: 'Gondola card info (hours, tickets, links, phone)',
        apply: 'Apply',
        filterByDestination: 'Filter by destination...',
        selectDestinationStops: 'Select destination stops...',
        filterRoutes: 'Filter routes',
        simpleNumbers: 'Simple numbers',
        showMinibuses: 'Show minibuses',
        showStopAnywhereSections: 'Show "stop-anywhere" sections',
        rustaviBuses: 'Rustavi buses',
        interface: 'Appearance',
        interfaceScale: 'Interface Scale',
        map: 'Map',
        auto: 'Auto',
        light: 'Light',
        dark: 'Dark',
        terrainSafariWarningIOS: 'To see 3D terrain in Safari please tap icon in the left part of address bar and select <b>Reduce Privacy Protections</b>',
        terrainSafariWarningDesktop: 'To see 3D terrain in Safari please select <b>View → Reload Reducing Privacy Protections</b>',
        map3DBuildings: '3D Buildings',
        map3DTerrain: '3D Terrain',
        exaggerateTerrain: 'Exaggerate Terrain',
        pointsOfInterest: 'Points of Interest',
        appOnline: 'App Online',
        appOffline: 'App Offline',
        privacyPolicy: 'Privacy Policy',
        support: 'Support',
        noRoutesForSelectedDestination: 'No routes for selected destination',
        noUpcomingArrivals: 'No upcoming arrivals',
        noArrivalsForSelectedDestination: 'No arrivals for selected destination',
        destinationUnknown: 'Destination Unknown',
        stopInOtherDirection: 'The selected stop is in the other direction.',
        scheduled: 'Scheduled',
        destination: 'Destination',
        previousStop: 'Previous stop',
        nextStop: 'Next stop',
        fromLabel: 'From {0}:',
        fromStopTime: 'From: {0} • {1}',
        toStopTime: 'To: {0} • {1}',
        switchDirectionForSchedule: 'Switch direction to view schedule.',
        noScheduleData: 'No schedule data available',
        failedToLoadSchedule: 'Failed to load schedule',
        weekdayMon: 'Mon',
        weekdayTue: 'Tue',
        weekdayWed: 'Wed',
        weekdayThu: 'Thu',
        weekdayFri: 'Fri',
        weekdaySat: 'Sat',
        weekdaySun: 'Sun',
        everyMinutes: 'every {0}\'',
        afterTimeEveryMinutes: 'after {0} — every {1}\'',
        onlyServiceRanges: 'only {0}',
        noServiceRanges: 'no service {0}',
        lessFrequentBetween: 'less frequent {0} – {1}',
        andAfterTime: '& after {0}',
        scheduledTripsCount: '{0} trips',
        scheduledTripsBetween: '{0} trips between {1} – {2}',
        variesDuringDay: 'varies during day',
        lateArrivalWarning: 'No buses scheduled at yellow times. Don\'t expect these buses',
        recentlySearched: 'RECENTLY SEARCHED',
        clearAll: 'CLEAR ALL',
        clearSearchHistoryPrompt: 'Clear search history?',
        showMore: 'Show more...',
        recentCards: 'RECENT CARDS',
        searchEmptyState: 'Type to search for stops, routes, or addresses',
        share: 'Share',
        filteredBySingle: 'Filtered by {0}',
        filteredByDouble: 'Filtered by {0} and {1}',
        filteredByTriple: 'Filtered by {0}, {1}, and {2}',
        filteredPlaqueSingleStop: '{0} stop',
        filteredPlaqueFewStops: '{0} stops',
        filteredPlaqueMultipleStops: '{0} stops',
        filteredPlaqueMinutes: '{0} min',
        filteredPlaqueMinutesRange: '{0}–{1} min',
        filteredPlaqueWithoutTraffic: 'Without traffic',
        codeLabel: 'Code: {0}',
        stopFallback: 'Stop {0}',
        supportMadeBy: 'Made by Sasha Berg',
        supportForCommuters: 'for Tbilisi commuters ♥'
    },
    ka: {
        appTitle: 'თბილისი ტრანსი',
        language: 'ენა',
        uiLanguage: 'ინტერფეისი',
        stopNamesLanguage: 'გაჩერებების სახელები',
        mapLanguage: 'რუკა',
        searchPlaceholder: 'მოძებნეთ ადგილი ან მარშრუტი...',
        clear: 'გასუფთავება',
        selectStop: 'აირჩიეთ გაჩერება',
        back: 'უკან',
        more: 'მეტი',
        edit: 'რედაქტირება',
        favorite: 'რჩეულებში დამატება',
        unfavorite: 'რჩეულებიდან ამოღება',
        copyLink: 'ბმულის კოპირება',
        streetScreen: 'ტაბლოს ჩვენება',
        close: 'დახურვა',
        minimize: 'ჩაკეცვა',
        directionsTitle: 'მიმართულებები',
        startingPoint: 'საწყისი წერტილი',
        destinationPoint: 'დანიშნულება',
        chooseStartingPoint: 'აირჩიეთ საწყისი წერტილი',
        chooseDestination: 'აირჩიეთ დანიშნულება',
        clearStartingPoint: 'საწყისი წერტილის გასუფთავება',
        clearDestination: 'დანიშნულების გასუფთავება',
        reverseDirections: 'მიმართულებების გადაბრუნება',
        options: 'პარამეტრები',
        bus: 'ავტობუსი',
        metro: 'მეტრო',
        cableCar: 'გონდოლა',
        routePriority: 'მარშრუტის პრიორიტეტი',
        faster: 'სწრაფი',
        lessWalking: 'ნაკლები სიარული',
        lessTransfers: 'ნაკლები გადაჯდომა',
        timeAndDate: 'დრო და თარიღი',
        tripMode: 'მგზავრობის რეჟიმი',
        departAt: 'გასვლა',
        arriveBy: 'ჩამოსვლა',
        leaveNow: 'ახლავე გასვლა',
        now: 'ახლა',
        tripTime: 'მგზავრობის დრო',
        adjustTime: 'დროის შეცვლა',
        earlierTime: 'ადრე',
        laterTime: 'გვიან',
        adjustDate: 'თარიღის შეცვლა',
        previousDay: 'წინა დღე',
        nextDay: 'შემდეგი დღე',
        chooseDate: 'აირჩიეთ თარიღი',
        previousMonth: 'წინა თვე',
        nextMonth: 'შემდეგი თვე',
        today: 'დღეს',
        tomorrow: 'ხვალ',
        routeOptionsReady: 'მარშრუტის ვარიანტები აქ გამოჩნდება, როგორც კი დამგეგმავი შეერთდება.',
        routeOptionsEmpty: 'აირჩიეთ ორი წერტილი მარშრუტის ვარიანტების სანახავად.',
        directionsFromHere: 'მიმართულებები აქედან',
        directionsToHere: 'მიმართულებები აქამდე',
        location: 'მდებარეობა',
        myLocation: 'ჩემი მდებარეობა',
        rotation: 'ბრუნვა',
        mergeInto: 'შერწყმა...',
        hubWith: 'ჰაბად გაერთიანება...',
        restoreEnglish: 'ინგლისური ვერსიის აღდგენა',
        restoreGeorgian: 'ქართული ვერსიის აღდგენა',
        gondolaInfoPlaceholder: 'გონდოლის ბარათის ინფორმაცია (საათები, ბილეთები, ბმულები, ტელეფონი)',
        apply: 'გამოყენება',
        filterByDestination: 'გაფილტვრა დანიშნულებით...',
        selectDestinationStops: 'აირჩიეთ დანიშნულების გაჩერებები...',
        filterRoutes: 'მარშრუტების გაფილტვრა',
        simpleNumbers: 'გამარტივებული ნომრები',
        showMinibuses: 'მიკროავტობუსების ჩვენება',
        showStopAnywhereSections: 'მოთხოვნით გაჩერების მონაკვეთების ჩვენება',
        rustaviBuses: 'რუსთავის ავტობუსები',
        interface: 'იერსახე',
        interfaceScale: 'ინტერფეისის მასშტაბი',
        map: 'რუკა',
        auto: 'ავტო',
        light: 'ღია',
        dark: 'მუქი',
        terrainSafariWarningIOS: 'Safari-ში 3D რელიეფის სანახავად შეეხეთ მისამართის ზოლის მარცხენა მხარეს მდებარე ხატულას და აირჩიეთ <b>Reduce Privacy Protections</b>',
        terrainSafariWarningDesktop: 'Safari-ში 3D რელიეფის სანახავად აირჩიეთ <b>View → Reload Reducing Privacy Protections</b>',
        map3DBuildings: '3D შენობები',
        map3DTerrain: '3D რელიეფი',
        exaggerateTerrain: 'რელიეფის გაძლიერება',
        pointsOfInterest: 'საინტერესო ობიექტები',
        appOnline: 'აპი ონლაინ რეჟიმშია',
        appOffline: 'აპი ოფლაინ რეჟიმშია',
        privacyPolicy: 'კონფიდენციალურობის პოლიტიკა',
        support: 'დახმარება',
        noRoutesForSelectedDestination: 'ამ დანიშნულებისკენ მარშრუტები არ არის',
        noUpcomingArrivals: 'უახლოესი ჩამოსვლები არ არის',
        noArrivalsForSelectedDestination: 'ამ დანიშნულებისთვის ჩამოსვლები არ არის',
        destinationUnknown: 'დანიშნულება უცნობია',
        stopInOtherDirection: 'არჩეული გაჩერება საპირისპირო მიმართულებითაა.',
        scheduled: 'განრიგით',
        destination: 'დანიშნულება',
        previousStop: 'წინა გაჩერება',
        nextStop: 'შემდეგი გაჩერება',
        fromLabel: '{0}-დან:',
        fromStopTime: 'საიდან: {0} • {1}',
        toStopTime: 'სადამდე: {0} • {1}',
        switchDirectionForSchedule: 'განრიგის სანახავად მიმართულება შეცვალეთ.',
        noScheduleData: 'განრიგის მონაცემები არ არის',
        failedToLoadSchedule: 'განრიგი ვერ ჩაიტვირთა',
        weekdayMon: 'ორშ',
        weekdayTue: 'სამ',
        weekdayWed: 'ოთხ',
        weekdayThu: 'ხუთ',
        weekdayFri: 'პარ',
        weekdaySat: 'შაბ',
        weekdaySun: 'კვი',
        everyMinutes: 'ყოველ {0}\'',
        afterTimeEveryMinutes: '{0}-ის შემდეგ — ყოველ {1}\'',
        onlyServiceRanges: 'მხოლოდ {0}',
        noServiceRanges: '{0} პერიოდში არ მოძრაობს',
        lessFrequentBetween: '{0}–{1} შუალედში უფრო იშვიათად',
        andAfterTime: 'და {0}-ის შემდეგ',
        scheduledTripsCount: '{0} რეისი',
        scheduledTripsBetween: '{0} რეისი {1} – {2}',
        variesDuringDay: 'დღის განმავლობაში იცვლება',
        lateArrivalWarning: 'ყვითლად მონიშნულ დროს ავტობუსები განრიგით აღარ მოძრაობენ. ამ ავტობუსებს ნუ დაელოდებით',
        recentlySearched: 'ბოლო ძიებები',
        clearAll: 'ყველაფრის გასუფთავება',
        clearSearchHistoryPrompt: 'წაიშალოს ძიების ისტორია?',
        showMore: 'მეტის ჩვენება...',
        recentCards: 'ბოლო ბარათები',
        searchEmptyState: 'აკრიფეთ გაჩერების, მარშრუტის ან მისამართის საძიებლად',
        share: 'გაზიარება',
        filteredBySingle: 'გაფილტრულია: {0}',
        filteredByDouble: 'გაფილტრულია: {0} და {1}',
        filteredByTriple: 'გაფილტრულია: {0}, {1} და {2}',
        filteredPlaqueSingleStop: '{0} გაჩერება',
        filteredPlaqueFewStops: '{0} გაჩერება',
        filteredPlaqueMultipleStops: '{0} გაჩერება',
        filteredPlaqueMinutes: '{0} წთ',
        filteredPlaqueMinutesRange: '{0}–{1} წთ',
        filteredPlaqueWithoutTraffic: 'საცობების გაუთვალისწინებლად',
        codeLabel: 'კოდი: {0}',
        stopFallback: 'გაჩერება {0}',
        supportMadeBy: 'ავტორი: Sasha Berg',
        supportForCommuters: 'თბილისელი მგზავრებისთვის ♥'
    },
    ru: {
        appTitle: 'Тбилиси Транс',
        language: 'Язык',
        uiLanguage: 'Интерфейс',
        stopNamesLanguage: 'Названия остановок',
        mapLanguage: 'Карта',
        searchPlaceholder: 'Поиск мест или маршрутов...',
        clear: 'Очистить',
        selectStop: 'Выберите остановку',
        back: 'Назад',
        more: 'Ещё',
        edit: 'Редактировать',
        favorite: 'В избранное',
        unfavorite: 'Убрать из избранного',
        copyLink: 'Копировать ссылку',
        streetScreen: 'Показать табло',
        close: 'Закрыть',
        minimize: 'Свернуть',
        directionsTitle: 'Маршруты',
        startingPoint: 'Точка отправления',
        destinationPoint: 'Пункт назначения',
        chooseStartingPoint: 'Выберите точку отправления',
        chooseDestination: 'Выберите пункт назначения',
        clearStartingPoint: 'Очистить точку отправления',
        clearDestination: 'Очистить пункт назначения',
        reverseDirections: 'Поменять местами',
        options: 'Параметры',
        bus: 'Автобус',
        metro: 'Метро',
        cableCar: 'Канатная дорога',
        routePriority: 'Приоритет маршрута',
        faster: 'Быстрее',
        lessWalking: 'Меньше ходьбы',
        lessTransfers: 'Меньше пересадок',
        timeAndDate: 'Время и дата',
        tripMode: 'Режим поездки',
        departAt: 'Отправление',
        arriveBy: 'Прибытие',
        leaveNow: 'Выехать сейчас',
        now: 'Сейчас',
        tripTime: 'Время поездки',
        adjustTime: 'Изменить время',
        earlierTime: 'Раньше',
        laterTime: 'Позже',
        adjustDate: 'Изменить дату',
        previousDay: 'Предыдущий день',
        nextDay: 'Следующий день',
        chooseDate: 'Выберите дату',
        previousMonth: 'Предыдущий месяц',
        nextMonth: 'Следующий месяц',
        today: 'сегодня',
        tomorrow: 'завтра',
        routeOptionsReady: 'Варианты маршрута появятся здесь после подключения планировщика.',
        routeOptionsEmpty: 'Выберите две точки, чтобы посмотреть варианты маршрута.',
        directionsFromHere: 'Маршрут отсюда',
        directionsToHere: 'Маршрут сюда',
        location: 'Позиция',
        myLocation: 'Мое местоположение',
        rotation: 'Поворот',
        mergeInto: 'Объединить в...',
        hubWith: 'Сделать хабом с...',
        restoreEnglish: 'Восстановить английский',
        restoreGeorgian: 'Восстановить грузинский',
        gondolaInfoPlaceholder: 'Информация для карточки канатки (часы, билеты, ссылки, телефон)',
        apply: 'Применить',
        filterByDestination: 'Фильтр по направлению...',
        selectDestinationStops: 'Выберите остановки назначения...',
        filterRoutes: 'Фильтр маршрутов',
        simpleNumbers: 'Простые номера',
        showMinibuses: 'Показывать маршрутки',
        showStopAnywhereSections: 'Показывать участки "остановка в любом месте"',
        rustaviBuses: 'Автобусы Рустави',
        interface: 'Оформление',
        interfaceScale: 'Масштаб интерфейса',
        map: 'Карта',
        auto: 'Авто',
        light: 'Светлая',
        dark: 'Тёмная',
        terrainSafariWarningIOS: 'Чтобы увидеть 3D-рельеф в Safari, нажмите значок в левой части адресной строки и выберите <b>Reduce Privacy Protections</b>',
        terrainSafariWarningDesktop: 'Чтобы увидеть 3D-рельеф в Safari, выберите <b>View → Reload Reducing Privacy Protections</b>',
        map3DBuildings: '3D здания',
        map3DTerrain: '3D рельеф',
        exaggerateTerrain: 'Усилить рельеф',
        pointsOfInterest: 'Точки интереса',
        appOnline: 'Приложение онлайн',
        appOffline: 'Приложение офлайн',
        privacyPolicy: 'Политика конфиденциальности',
        support: 'Поддержка',
        noRoutesForSelectedDestination: 'Для выбранного направления маршруты не найдены',
        noUpcomingArrivals: 'Ближайших прибытий нет',
        noArrivalsForSelectedDestination: 'Для выбранного направления прибытий нет',
        destinationUnknown: 'Направление неизвестно',
        stopInOtherDirection: 'Выбранная остановка находится в другом направлении.',
        scheduled: 'По расписанию',
        destination: 'Направление',
        previousStop: 'Предыдущая остановка',
        nextStop: 'Следующая остановка',
        fromLabel: 'От {0}:',
        fromStopTime: 'От: {0} • {1}',
        toStopTime: 'До: {0} • {1}',
        switchDirectionForSchedule: 'Переключите направление, чтобы посмотреть расписание.',
        noScheduleData: 'Данные расписания недоступны',
        failedToLoadSchedule: 'Не удалось загрузить расписание',
        weekdayMon: 'Пн',
        weekdayTue: 'Вт',
        weekdayWed: 'Ср',
        weekdayThu: 'Чт',
        weekdayFri: 'Пт',
        weekdaySat: 'Сб',
        weekdaySun: 'Вс',
        everyMinutes: 'каждые {0}\'',
        afterTimeEveryMinutes: 'после {0} — каждые {1}\'',
        onlyServiceRanges: 'только {0}',
        noServiceRanges: 'нет движения {0}',
        lessFrequentBetween: 'реже {0} – {1}',
        andAfterTime: 'и после {0}',
        scheduledTripsCount: '{0} рейсов',
        scheduledTripsBetween: '{0} рейсов между {1} – {2}',
        variesDuringDay: 'меняется в течение дня',
        lateArrivalWarning: 'По расписанию в жёлтое время автобусы уже не ходят. Не рассчитывайте на эти автобусы',
        recentlySearched: 'НЕДАВНИЕ ПОИСКИ',
        clearAll: 'ОЧИСТИТЬ ВСЁ',
        clearSearchHistoryPrompt: 'Очистить историю поиска?',
        showMore: 'Показать ещё...',
        recentCards: 'НЕДАВНИЕ КАРТОЧКИ',
        searchEmptyState: 'Введите запрос для поиска остановок, маршрутов или адресов',
        share: 'Поделиться',
        filteredBySingle: 'Отфильтровано по: {0}',
        filteredByDouble: 'Отфильтровано по: {0} и {1}',
        filteredByTriple: 'Отфильтровано по: {0}, {1} и {2}',
        filteredPlaqueSingleStop: '{0} остановка',
        filteredPlaqueFewStops: '{0} остановки',
        filteredPlaqueMultipleStops: '{0} остановок',
        filteredPlaqueMinutes: '{0} мин',
        filteredPlaqueMinutesRange: '{0}–{1} мин',
        filteredPlaqueWithoutTraffic: 'Без учёта пробок',
        codeLabel: 'Код: {0}',
        stopFallback: 'Остановка {0}',
        supportMadeBy: 'Сделано Sasha Berg',
        supportForCommuters: 'для пассажиров Тбилиси ♥'
    }
};

type LanguageChange = {
    target: LanguageTarget;
    value: AppLanguage;
};

const listeners = new Set<(change: LanguageChange) => void>();

function normalizeAppLanguage(value: unknown): AppLanguage | null {
    if (value === 'en' || value === 'ka' || value === 'ru') return value;
    return null;
}

function normalizeUiLanguage(value: unknown): UiLanguage {
    if (value === 'ka' || value === 'ru' || value === 'en') return value;
    return 'en';
}

function normalizeStopNamesLanguage(value: unknown): StopLanguage {
    return value === 'ka' ? 'ka' : 'en';
}

function normalizeMapLanguage(value: unknown): MapLanguage {
    if (value === 'ka' || value === 'ru' || value === 'en') return value;
    return DEFAULT_MAP_LANGUAGE;
}

function getStoredValue(key: string): string | null {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(key);
}

function getUrlValue(key: string): string | null {
    if (typeof window === 'undefined') return null;
    return new URLSearchParams(window.location.search).get(key);
}

function getLegacyLanguageValue(): AppLanguage | null {
    return normalizeAppLanguage(getStoredValue(LEGACY_LANGUAGE_STORAGE_KEY) || getUrlValue(LEGACY_LANGUAGE_QUERY_PARAM));
}

function resolveInitialUiLanguage(): UiLanguage {
    const direct = getStoredValue(UI_LANGUAGE_STORAGE_KEY) || getUrlValue(UI_LANGUAGE_QUERY_PARAM);
    if (direct) return normalizeUiLanguage(direct);
    return normalizeUiLanguage(getLegacyLanguageValue());
}

function resolveInitialStopNamesLanguage(): StopLanguage {
    const direct = getStoredValue(STOP_NAMES_LANGUAGE_STORAGE_KEY) || getUrlValue(STOP_NAMES_LANGUAGE_QUERY_PARAM);
    if (direct) return normalizeStopNamesLanguage(direct);
    return normalizeStopNamesLanguage(getLegacyLanguageValue());
}

function resolveInitialMapLanguage(): MapLanguage {
    const direct = getStoredValue(MAP_LANGUAGE_STORAGE_KEY) || getUrlValue(MAP_LANGUAGE_QUERY_PARAM);
    if (direct) return normalizeMapLanguage(direct);
    return normalizeMapLanguage(getLegacyLanguageValue());
}

let currentUiLanguage: UiLanguage = resolveInitialUiLanguage();
let currentStopNamesLanguage: StopLanguage = resolveInitialStopNamesLanguage();
let currentMapLanguage: MapLanguage = resolveInitialMapLanguage();

function formatTemplate(template: string, values: Array<string | number>): string {
    return values.reduce(
        (result, value, index) => result.replaceAll(`{${index}}`, String(value)),
        template
    );
}

function updateDocumentLanguage() {
    if (typeof document === 'undefined') return;
    document.documentElement.lang = currentUiLanguage;
    document.title = t('appTitle');
}

function updateUrlLanguages() {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (currentUiLanguage === DEFAULT_UI_LANGUAGE) {
        url.searchParams.delete(UI_LANGUAGE_QUERY_PARAM);
    } else {
        url.searchParams.set(UI_LANGUAGE_QUERY_PARAM, currentUiLanguage);
    }
    if (currentStopNamesLanguage === DEFAULT_STOP_NAMES_LANGUAGE) {
        url.searchParams.delete(STOP_NAMES_LANGUAGE_QUERY_PARAM);
    } else {
        url.searchParams.set(STOP_NAMES_LANGUAGE_QUERY_PARAM, currentStopNamesLanguage);
    }
    if (currentMapLanguage === DEFAULT_MAP_LANGUAGE) {
        url.searchParams.delete(MAP_LANGUAGE_QUERY_PARAM);
    } else {
        url.searchParams.set(MAP_LANGUAGE_QUERY_PARAM, currentMapLanguage);
    }
    url.searchParams.delete(LEGACY_LANGUAGE_QUERY_PARAM);
    const nextUrl = `${url.pathname}${url.search}${url.hash}`;
    window.history.replaceState(null, '', nextUrl);
}

function persistCurrentLanguages() {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, currentUiLanguage);
    localStorage.setItem(STOP_NAMES_LANGUAGE_STORAGE_KEY, currentStopNamesLanguage);
    localStorage.setItem(MAP_LANGUAGE_STORAGE_KEY, currentMapLanguage);
}

function notifyChange(target: LanguageTarget, value: AppLanguage) {
    listeners.forEach((listener) => listener({ target, value }));
}

export function getCurrentLanguage(): UiLanguage {
    return currentUiLanguage;
}

export function getCurrentUiLanguage(): UiLanguage {
    return currentUiLanguage;
}

export function getCurrentStopNamesLanguage(): StopLanguage {
    return currentStopNamesLanguage;
}

export function getCurrentMapLanguage(): MapLanguage {
    return currentMapLanguage;
}

export function getCurrentLocale(): UiLanguage {
    return currentUiLanguage;
}

export function getTransitDataLocale(): StopLanguage {
    return currentStopNamesLanguage;
}

export function t(key: string, ...values: Array<string | number>): string {
    const table = STRINGS[currentUiLanguage] || STRINGS[DEFAULT_UI_LANGUAGE];
    const fallbackTable = STRINGS[DEFAULT_UI_LANGUAGE];
    const template = table[key] ?? fallbackTable[key] ?? key;
    return values.length > 0 ? formatTemplate(template, values) : template;
}

export function setUiLanguage(language: UiLanguage) {
    const nextLanguage = normalizeUiLanguage(language);
    if (nextLanguage === currentUiLanguage) return;
    currentUiLanguage = nextLanguage;
    persistCurrentLanguages();
    updateDocumentLanguage();
    updateUrlLanguages();
    applyStaticText();
    notifyChange('ui', nextLanguage);
}

export function setStopNamesLanguage(language: StopLanguage) {
    const nextLanguage = normalizeStopNamesLanguage(language);
    if (nextLanguage === currentStopNamesLanguage) return;
    currentStopNamesLanguage = nextLanguage;
    persistCurrentLanguages();
    updateUrlLanguages();
    syncLanguageControls();
    notifyChange('stops', nextLanguage);
}

export function setMapLanguage(language: MapLanguage) {
    const nextLanguage = normalizeMapLanguage(language);
    if (nextLanguage === currentMapLanguage) return;
    currentMapLanguage = nextLanguage;
    persistCurrentLanguages();
    updateUrlLanguages();
    syncLanguageControls();
    notifyChange('map', nextLanguage);
}

export function setCurrentLanguage(language: AppLanguage) {
    setUiLanguage(normalizeUiLanguage(language));
    setStopNamesLanguage(normalizeStopNamesLanguage(language));
    setMapLanguage(normalizeMapLanguage(language));
}

export function onLanguageChange(listener: (change: LanguageChange) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function initI18n() {
    currentUiLanguage = resolveInitialUiLanguage();
    currentStopNamesLanguage = resolveInitialStopNamesLanguage();
    currentMapLanguage = resolveInitialMapLanguage();
    persistCurrentLanguages();
    updateDocumentLanguage();
    updateUrlLanguages();
    applyStaticText();
}

export function formatFilteredSubtitle(names: string[]): string {
    if (!Array.isArray(names) || names.length === 0) return '';
    if (names.length === 1) return t('filteredBySingle', names[0]);
    if (names.length === 2) return t('filteredByDouble', names[0], names[1]);
    return t('filteredByTriple', names[0], names[1], names[2]);
}

export function formatFilteredStopCount(count: number): string {
    const safeCount = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;

    if (currentUiLanguage === 'ru') {
        const mod10 = safeCount % 10;
        const mod100 = safeCount % 100;
        if (mod10 === 1 && mod100 !== 11) {
            return t('filteredPlaqueSingleStop', String(safeCount));
        }
        if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
            return t('filteredPlaqueFewStops', String(safeCount));
        }
        return t('filteredPlaqueMultipleStops', String(safeCount));
    }

    if (safeCount === 1) {
        return t('filteredPlaqueSingleStop', String(safeCount));
    }

    return t('filteredPlaqueMultipleStops', String(safeCount));
}

function setText(id: string, value: string) {
    const element = document.getElementById(id);
    if (element) element.textContent = value;
}

function setPlaceholder(id: string, value: string) {
    const element = document.getElementById(id);
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        element.placeholder = value;
    }
}

function setTitle(id: string, value: string) {
    const element = document.getElementById(id);
    if (element) element.setAttribute('title', value);
}

function setAriaLabel(id: string, value: string) {
    const element = document.getElementById(id);
    if (element) element.setAttribute('aria-label', value);
}

function setInnerHtml(id: string, value: string) {
    const element = document.getElementById(id);
    if (element) element.innerHTML = value;
}

function getButtonLanguageValue(setting: string | undefined, value: string | undefined): AppLanguage | null {
    if (!setting || !value) return null;
    if (setting === 'ui') return normalizeUiLanguage(value);
    if (setting === 'stops') return normalizeStopNamesLanguage(value);
    if (setting === 'map') return normalizeMapLanguage(value);
    return null;
}

function getCurrentValueForSetting(setting: string | undefined): AppLanguage | null {
    if (setting === 'ui') return currentUiLanguage;
    if (setting === 'stops') return currentStopNamesLanguage;
    if (setting === 'map') return currentMapLanguage;
    return null;
}

function syncLanguageControls() {
    document.querySelectorAll<HTMLElement>('[data-language-setting][data-language-option]').forEach((button) => {
        const expectedValue = getButtonLanguageValue(button.dataset.languageSetting, button.dataset.languageOption);
        const currentValue = getCurrentValueForSetting(button.dataset.languageSetting);
        const active = !!expectedValue && expectedValue === currentValue;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
}

export function applyStaticText() {
    if (typeof document === 'undefined') return;

    setPlaceholder('search-input', t('searchPlaceholder'));
    setTitle('search-clear', t('clear'));
    const stopPanel = document.getElementById('info-panel');
    const stopPanelHidden = !stopPanel || stopPanel.classList.contains('hidden');
    if (stopPanelHidden && !window.currentStopId) {
        setText('stop-name', t('selectStop'));
    }
    setTitle('back-panel', t('back'));
    setTitle('stop-more-btn', t('more'));
    setText('btn-edit-stop', t('edit'));
    setTitle('btn-edit-stop', t('edit'));
    setText('favorite-stop-btn', t('favorite'));
    setTitle('favorite-stop-btn', t('favorite'));
    setText('copy-link-btn', t('copyLink'));
    setTitle('copy-link-btn', t('copyLink'));
    setText('open-street-screen-label', t('streetScreen'));
    setTitle('open-street-screen-btn', t('streetScreen'));
    setTitle('close-panel', t('close'));
    setText('edit-toggle-loc', t('location'));
    setText('edit-toggle-rot', t('rotation'));
    setText('edit-toggle-merge', t('mergeInto'));
    setText('edit-toggle-hub', t('hubWith'));
    setTitle('edit-restore-en', t('restoreEnglish'));
    setTitle('edit-restore-ka', t('restoreGeorgian'));
    setPlaceholder('edit-gondola-info', t('gondolaInfoPlaceholder'));
    setText('edit-btn-apply', t('apply'));
    const filterLabel = document.querySelector('#filter-routes-toggle .filter-text');
    if (filterLabel) filterLabel.textContent = t('filterByDestination');
    setTitle('back-route-info', t('back'));
    setTitle('route-more-btn', t('more'));
    setText('btn-edit-route', t('edit'));
    setTitle('btn-edit-route', t('edit'));
    setText('favorite-route-btn', t('favorite'));
    setTitle('favorite-route-btn', t('favorite'));
    setText('copy-route-link-btn', t('copyLink'));
    setTitle('copy-route-link-btn', t('copyLink'));
    setTitle('close-route-info', t('close'));
    setTitle('street-screen-close', t('close'));
    setText('directions-title', t('directionsTitle'));
    setTitle('close-directions', t('minimize'));
    setPlaceholder('directions-from-input', t('chooseStartingPoint'));
    setPlaceholder('directions-to-input', t('chooseDestination'));
    setTitle('directions-clear-from', t('clearStartingPoint'));
    setTitle('directions-clear-to', t('clearDestination'));
    setTitle('directions-reverse', t('reverseDirections'));
    setText('directions-options-summary-label', t('options'));
    setText('directions-mode-bus-label', t('bus'));
    setText('directions-mode-subway-label', t('metro'));
    setText('directions-mode-gondola-label', t('cableCar'));
    setAriaLabel('directions-segmented', t('routePriority'));
    setText('directions-optimize-quick-label', t('faster'));
    setText('directions-optimize-less-walking-label', t('lessWalking'));
    setText('directions-optimize-less-transfers-label', t('lessTransfers'));
    setText('directions-time-and-date-label', t('timeAndDate'));
    setAriaLabel('directions-time-mode-select', t('tripMode'));
    setText('directions-time-mode-depart-option', t('departAt'));
    setText('directions-time-mode-arrive-option', t('arriveBy'));
    setText('directions-now-btn', t('now'));
    setAriaLabel('directions-time-input', t('tripTime'));
    setAriaLabel('directions-time-prev', t('earlierTime'));
    setAriaLabel('directions-time-next', t('laterTime'));
    setAriaLabel('directions-date-prev', t('previousDay'));
    setAriaLabel('directions-date-next', t('nextDay'));
    setAriaLabel('directions-calendar-popover', t('chooseDate'));
    setAriaLabel('directions-calendar-prev', t('previousMonth'));
    setAriaLabel('directions-calendar-next', t('nextMonth'));
    setText('directions-weekday-mon', t('weekdayMon'));
    setText('directions-weekday-tue', t('weekdayTue'));
    setText('directions-weekday-wed', t('weekdayWed'));
    setText('directions-weekday-thu', t('weekdayThu'));
    setText('directions-weekday-fri', t('weekdayFri'));
    setText('directions-weekday-sat', t('weekdaySat'));
    setText('directions-weekday-sun', t('weekdaySun'));
    setText('directions-placeholder', t('routeOptionsEmpty'));
    setText('directions-context-from-text', t('directionsFromHere'));
    setText('directions-context-to-text', t('directionsToHere'));
    setText('place-dir-from-text', t('directionsFromHere'));
    setText('place-dir-to-text', t('directionsToHere'));
    setAriaLabel('menu-btn', t('more'));
    setText('menu-ui-language-label', t('uiLanguage'));
    setText('menu-stop-names-label', t('stopNamesLanguage'));
    setText('menu-map-language-label', t('mapLanguage'));
    setText('menu-simple-numbers-label', t('simpleNumbers'));
    setText('menu-show-minibuses-label', t('showMinibuses'));
    setText('menu-stop-anywhere-label', t('showStopAnywhereSections'));
    setText('menu-rustavi-buses-label', t('rustaviBuses'));
    setText('map-section-title', t('map'));
    setText('menu-3d-buildings-label', t('map3DBuildings'));
    setText('menu-3d-terrain-label', t('map3DTerrain'));
    setText('menu-exaggerate-label', t('exaggerateTerrain'));
    setText('menu-poi-label', t('pointsOfInterest'));
    setText('interface-section-title', t('interface'));
    setText('theme-option-system', t('auto'));
    setText('theme-option-light', t('light'));
    setText('theme-option-dark', t('dark'));
    setText('page-scale-label', t('interfaceScale'));
    const safariWarning = document.getElementById('terrain-safari-warning');
    if (safariWarning) {
        safariWarning.innerHTML = /iPhone|iPad|iPod/.test(navigator.userAgent)
            ? t('terrainSafariWarningIOS')
            : t('terrainSafariWarningDesktop');
    }
    setText('privacy-policy-title', t('privacyPolicy'));
    setTitle('privacy-policy-close', t('close'));
    const privacyFrame = document.getElementById('privacy-policy-frame');
    if (privacyFrame) privacyFrame.setAttribute('title', t('privacyPolicy'));
    setText('support-title', t('support'));
    setTitle('support-close', t('close'));
    const supportFrame = document.getElementById('support-frame');
    if (supportFrame) supportFrame.setAttribute('title', t('support'));
    setInnerHtml('menu-contact-copy', `${t('supportMadeBy')}<br>${t('supportForCommuters')}`);

    syncLanguageControls();
}
