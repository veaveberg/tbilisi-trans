import UIKit

struct FavoriteListItem {
    let key: String
    let type: String
    let title: String
    let subtitle: String
    let routeNumber: String
    let routeColor: String
    let stopIcon: String
}

final class SettingsViewController: UITableViewController {
    
    // MARK: - Item Types
    
    enum ItemType {
        case toggle
        case themeSegment // Auto / Light / Dark
        case scaleSlider  // 0.8 - 1.5
        case submenu
    }
    
    struct Item {
        let key: String
        let title: String
        let type: ItemType
        let icon: String?
        
        init(key: String, title: String, type: ItemType = .toggle, icon: String? = nil) {
            self.key = key
            self.title = title
            self.type = type
            self.icon = icon
        }
    }

    struct Section {
        let title: String
        let items: [Item]
    }

    private let sections: [Section] = [
        Section(title: "", items: [
            Item(key: "favoritesMenu", title: "Favorites", type: .submenu, icon: "star"),
            Item(key: "icloudSyncEnabled", title: "iCloud Sync (History + Favorites)", icon: "icloud")
        ]),
        Section(title: "Routes", items: [
            Item(key: "simplifyNumbers", title: "Simplify Route Numbers", icon: "numbers.rectangle"),
            Item(key: "showMinibuses", title: "Show Minibuses"),
            Item(key: "showMinibusSegments", title: "Show \"stop-anywhere\" Sections"),
            Item(key: "showRustaviBuses", title: "Show Rustavi Buses")
        ]),
        Section(title: "Map", items: [
            Item(key: "show3DBuildings", title: "3D Buildings", icon: "building.2.fill"),
            Item(key: "show3DTerrain", title: "3D Terrain", icon: "mountain.2.fill"),
            Item(key: "exaggerateTerrain", title: "Exaggerate Terrain", icon: "rectangle.expand.vertical"),
            Item(key: "showPoiLabels", title: "Points of Interest", icon: "mappin.and.ellipse")
        ]),
        Section(title: "Interface", items: [
            Item(key: "theme", title: "Theme", type: .themeSegment),
            Item(key: "pageScale", title: "Interface Scale", type: .scaleSlider)
        ]),
        Section(title: "", items: [
            Item(key: "support", title: "Support", type: .submenu),
            Item(key: "privacyPolicy", title: "Privacy Policy", type: .submenu)
        ])
    ]

    private var boolValues: [String: Bool] = [:]
    private var themeValue: String = "system"
    private var scaleValue: Float = 1.0
    private var favoritesList: [FavoriteListItem] = []
    
    private let scaleMin: Float = 0.8
    private let scaleMax: Float = 1.5
    private let scaleStep: Float = 0.05

    var onToggle: ((String, Any) -> Void)?
    var onDone: (([String: Any]) -> Void)?
    var onOpenPrivacyPolicy: (() -> Void)?
    var onOpenSupport: (() -> Void)?

    override func viewDidLoad() {
        super.viewDidLoad()

        title = "Settings"
        tableView = UITableView(frame: .zero, style: .insetGrouped)
        tableView.register(UITableViewCell.self, forCellReuseIdentifier: "ToggleCell")
        tableView.register(ThemeSegmentCell.self, forCellReuseIdentifier: "ThemeSegmentCell")
        tableView.register(ScaleSliderCell.self, forCellReuseIdentifier: "ScaleSliderCell")

        navigationItem.rightBarButtonItem = UIBarButtonItem(
            barButtonSystemItem: .done,
            target: self,
            action: #selector(doneTapped)
        )
        
        // Add version footer
        let version = (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? "?"
        let build = (Bundle.main.infoDictionary?["CFBundleVersion"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? "?"
        
        let footerLabel = UILabel()
        footerLabel.text = "Version \(version) (\(build))"
        footerLabel.font = .systemFont(ofSize: 13)
        footerLabel.textColor = .secondaryLabel
        footerLabel.textAlignment = .center
        footerLabel.frame = CGRect(x: 0, y: 0, width: 0, height: 44)
        tableView.tableFooterView = footerLabel
    }

    func applySettings(_ settings: [String: Any]) {
        var next: [String: Bool] = [:]
        for section in sections {
            for item in section.items where item.type == .toggle {
                if let value = settings[item.key] as? Bool {
                    next[item.key] = value
                }
            }
        }
        boolValues = next
        
        // Theme: "system", "light", or "dark"
        if let theme = settings["theme"] as? String {
            themeValue = theme
        }
        
        // Scale: Float between 0.8 and 1.5
        if let scale = settings["pageScale"] as? Double {
            scaleValue = Float(scale)
        } else if let scale = settings["pageScale"] as? Float {
            scaleValue = scale
        }

        if let rawList = settings["favoritesList"] as? [[String: Any]] {
            favoritesList = rawList.compactMap { raw in
                let key = (raw["key"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                let type = (raw["type"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                let title = (raw["title"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                let subtitle = (raw["subtitle"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                let routeNumber = (raw["routeNumber"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                let routeColor = (raw["routeColor"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                let stopIcon = (raw["stopIcon"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                guard !key.isEmpty, (type == "stop" || type == "route") else { return nil }
                return FavoriteListItem(
                    key: key,
                    type: type,
                    title: title.isEmpty ? key : title,
                    subtitle: subtitle,
                    routeNumber: routeNumber,
                    routeColor: routeColor,
                    stopIcon: stopIcon
                )
            }
        } else {
            favoritesList = []
        }
    }
    
    private func getAllSettings() -> [String: Any] {
        var result: [String: Any] = [:]
        for (key, value) in boolValues {
            result[key] = value
        }
        result["theme"] = themeValue
        result["pageScale"] = Double(scaleValue)
        return result
    }

    private func displayedItems(in section: Int) -> [Item] {
        var items = sections[section].items
        let sectionTitle = sections[section].title
        if sectionTitle == "Routes", boolValues["showMinibuses"] == false {
            items.removeAll { $0.key == "showMinibusSegments" }
        }
        return items
    }

    private func routesSectionIndex() -> Int? {
        sections.firstIndex { $0.title == "Routes" }
    }

    @objc private func doneTapped() {
        onDone?(getAllSettings())
        dismiss(animated: true)
    }

    override func numberOfSections(in tableView: UITableView) -> Int {
        sections.count
    }

    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        displayedItems(in: section).count
    }

    override func tableView(_ tableView: UITableView, titleForHeaderInSection section: Int) -> String? {
        let title = sections[section].title.trimmingCharacters(in: .whitespacesAndNewlines)
        return title.isEmpty ? nil : title
    }
    
    override func tableView(_ tableView: UITableView, heightForRowAt indexPath: IndexPath) -> CGFloat {
        let item = displayedItems(in: indexPath.section)[indexPath.row]
        switch item.type {
        case .themeSegment:
            return 44
        case .scaleSlider:
            return 44
        case .submenu:
            return UITableView.automaticDimension
        case .toggle:
            return UITableView.automaticDimension
        }
    }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let item = displayedItems(in: indexPath.section)[indexPath.row]
        
        switch item.type {
        case .toggle:
            let cell: UITableViewCell
            if item.key == "icloudSyncEnabled" {
                let reuseId = "ToggleCellSubtitle"
                cell = tableView.dequeueReusableCell(withIdentifier: reuseId) ??
                    UITableViewCell(style: .subtitle, reuseIdentifier: reuseId)
            } else {
                cell = tableView.dequeueReusableCell(withIdentifier: "ToggleCell", for: indexPath)
            }
            cell.selectionStyle = .none
            if item.key == "icloudSyncEnabled" {
                cell.textLabel?.text = "iCloud Sync"
                cell.detailTextLabel?.text = "Also syncs search history"
                cell.detailTextLabel?.textColor = .secondaryLabel
            } else {
                cell.textLabel?.text = item.title
                cell.detailTextLabel?.text = nil
            }
            
            // Set icon
            if let iconName = item.icon {
                cell.imageView?.image = fixedWidthSymbolImage(named: iconName)
                cell.imageView?.tintColor = .label
            } else {
                cell.imageView?.image = nil
            }

            let toggle = UISwitch()
            toggle.isOn = boolValues[item.key] ?? false
            toggle.addTarget(self, action: #selector(toggleChanged(_:)), for: .valueChanged)
            toggle.accessibilityIdentifier = item.key
            cell.accessoryView = toggle
            return cell

        case .submenu:
            let cell = tableView.dequeueReusableCell(withIdentifier: "ToggleCell", for: indexPath)
            cell.selectionStyle = .default
            cell.textLabel?.text = item.title
            if let iconName = item.icon {
                cell.imageView?.image = UIImage(systemName: iconName)
                cell.imageView?.tintColor = .label
            } else {
                cell.imageView?.image = nil
            }
            cell.accessoryView = nil
            cell.accessoryType = .disclosureIndicator
            return cell
            
        case .themeSegment:
            let cell = tableView.dequeueReusableCell(withIdentifier: "ThemeSegmentCell", for: indexPath) as! ThemeSegmentCell
            cell.configure(selectedTheme: themeValue) { [weak self] newTheme in
                self?.themeValue = newTheme
                self?.onToggle?("theme", newTheme)
            }
            return cell
            
        case .scaleSlider:
            let cell = tableView.dequeueReusableCell(withIdentifier: "ScaleSliderCell", for: indexPath) as! ScaleSliderCell
            cell.configure(
                value: scaleValue,
                minValue: scaleMin,
                maxValue: scaleMax,
                step: scaleStep
            ) { [weak self] newScale in
                self?.scaleValue = newScale
                self?.onToggle?("pageScale", Double(newScale))
            }
            return cell
        }
    }

    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        let item = displayedItems(in: indexPath.section)[indexPath.row]
        defer { tableView.deselectRow(at: indexPath, animated: true) }
        guard item.type == .submenu else { return }

        if item.key == "favoritesMenu" {
            openFavoritesMenu()
        } else if item.key == "support" {
            onOpenSupport?()
        } else if item.key == "privacyPolicy" {
            onOpenPrivacyPolicy?()
        }
    }

    func openFavoritesMenu() {
        if let nav = navigationController, nav.topViewController is FavoritesMenuViewController {
            return
        }
        let controller = FavoritesMenuViewController()
        controller.items = favoritesList
        controller.onAction = { [weak self] action in
            self?.onToggle?("favoritesAction", action)
        }
        navigationController?.pushViewController(controller, animated: true)
    }

    private func fixedWidthSymbolImage(named symbolName: String) -> UIImage? {
        let config = UIImage.SymbolConfiguration(pointSize: 17, weight: .regular, scale: .medium)
        guard let symbol = UIImage(systemName: symbolName, withConfiguration: config) else { return nil }

        let canvas = CGSize(width: 20, height: 20)
        let renderer = UIGraphicsImageRenderer(size: canvas)
        let image = renderer.image { _ in
            let x = (canvas.width - symbol.size.width) / 2
            let y = (canvas.height - symbol.size.height) / 2
            symbol.draw(in: CGRect(origin: CGPoint(x: x, y: y), size: symbol.size))
        }
        return image.withRenderingMode(.alwaysTemplate)
    }

    @objc private func toggleChanged(_ sender: UISwitch) {
        guard let key = sender.accessibilityIdentifier else { return }

        if key == "icloudSyncEnabled" && sender.isOn {
            presentICloudEnableChoice(for: sender)
            return
        }

        boolValues[key] = sender.isOn
        onToggle?(key, sender.isOn)
        if key == "showMinibuses", let routesSection = routesSectionIndex() {
            tableView.reloadSections(IndexSet(integer: routesSection), with: .automatic)
        }
    }

    private func presentICloudEnableChoice(for sender: UISwitch) {
        let alert = UIAlertController(
            title: "Enable iCloud Sync",
            message: nil,
            preferredStyle: .actionSheet
        )

        alert.addAction(UIAlertAction(title: "Merge Local + iCloud", style: .default) { [weak self] _ in
            guard let self else { return }
            self.boolValues["icloudSyncEnabled"] = true
            // Send mode first so JS applies chosen strategy immediately when toggle event arrives.
            self.onToggle?("icloudSyncMode", "merge")
            self.onToggle?("icloudSyncEnabled", true)
        })

        alert.addAction(UIAlertAction(title: "Replace Local Data with iCloud Data", style: .destructive) { [weak self] _ in
            guard let self else { return }
            self.boolValues["icloudSyncEnabled"] = true
            self.onToggle?("icloudSyncMode", "replace")
            self.onToggle?("icloudSyncEnabled", true)
        })

        alert.addAction(UIAlertAction(title: "Replace iCloud Data with Local Data", style: .destructive) { [weak self] _ in
            guard let self else { return }
            self.boolValues["icloudSyncEnabled"] = true
            self.onToggle?("icloudSyncMode", "pushLocal")
            self.onToggle?("icloudSyncEnabled", true)
        })

        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { [weak self] _ in
            guard let self else { return }
            sender.setOn(false, animated: true)
            self.boolValues["icloudSyncEnabled"] = false
            self.onToggle?("icloudSyncEnabled", false)
        })

        if let popover = alert.popoverPresentationController {
            popover.sourceView = sender
            popover.sourceRect = sender.bounds
        }

        present(alert, animated: true)
    }

}

// MARK: - Favorites Menu

final class FavoritesMenuViewController: UITableViewController, UITableViewDragDelegate, UITableViewDropDelegate {
    var items: [FavoriteListItem] = []
    var onAction: ((Any) -> Void)?
    private var badgeImageCache: [String: UIImage] = [:]
    private var didPrewarmSwipeActions = false

    private enum SectionKind: Int, CaseIterable {
        case stops
        case routes
        case actions
    }

    private var stopItems: [FavoriteListItem] = []
    private var routeItems: [FavoriteListItem] = []
    init() {
        super.init(style: .insetGrouped)
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Favorites"
        tableView.register(UITableViewCell.self, forCellReuseIdentifier: "FavoritesActionCell")
        tableView.register(UITableViewCell.self, forCellReuseIdentifier: "FavoritesEmptyCell")
        tableView.register(FavoriteItemCell.self, forCellReuseIdentifier: "FavoriteItemCell")
        tableView.dragInteractionEnabled = true
        tableView.dragDelegate = self
        tableView.dropDelegate = self
        tableView.delaysContentTouches = false
        tableView.canCancelContentTouches = true
        tableView.sectionHeaderTopPadding = 8
        tableView.rowHeight = UITableView.automaticDimension
        tableView.estimatedRowHeight = 60
        stopItems = items.filter { $0.type == "stop" }
        routeItems = items.filter { $0.type == "route" }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        prewarmSwipeActionsIfNeeded()
    }

    override func numberOfSections(in tableView: UITableView) -> Int {
        SectionKind.allCases.count
    }

    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        guard let kind = SectionKind(rawValue: section) else { return 0 }
        switch kind {
        case .stops:
            return max(stopItems.count, 1)
        case .routes:
            return max(routeItems.count, 1)
        case .actions:
            return 1
        }
    }

    override func tableView(_ tableView: UITableView, titleForHeaderInSection section: Int) -> String? {
        guard let kind = SectionKind(rawValue: section) else { return nil }
        switch kind {
        case .stops:
            return "Stops"
        case .routes:
            return "Routes"
        case .actions:
            return nil
        }
    }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        guard let kind = SectionKind(rawValue: indexPath.section) else {
            return UITableViewCell()
        }

        switch kind {
        case .actions:
            let cell = tableView.dequeueReusableCell(withIdentifier: "FavoritesActionCell", for: indexPath)
            cell.textLabel?.text = "Clear All Favorites"
            cell.textLabel?.textColor = .systemRed
            cell.detailTextLabel?.text = nil
            cell.imageView?.image = UIImage(systemName: "trash")
            cell.imageView?.tintColor = .systemRed
            cell.accessoryType = .none
            cell.selectionStyle = .default
            return cell

        case .stops, .routes:
            let sectionItems = kind == .stops ? stopItems : routeItems
            if sectionItems.isEmpty {
                let cell = tableView.dequeueReusableCell(withIdentifier: "FavoritesEmptyCell", for: indexPath)
                cell.textLabel?.text = kind == .stops ? "No favorite stops" : "No favorite routes"
                cell.textLabel?.textColor = .secondaryLabel
                cell.imageView?.image = nil
                cell.accessoryType = .none
                cell.selectionStyle = .none
                return cell
            }

            let item = sectionItems[indexPath.row]
            guard let cell = tableView.dequeueReusableCell(withIdentifier: "FavoriteItemCell", for: indexPath) as? FavoriteItemCell else {
                return UITableViewCell()
            }
            let isRoute = kind == .routes
            let routeName = item.title.hasPrefix("Route ") && !item.subtitle.isEmpty ? item.subtitle : item.title
            cell.selectionStyle = .default
            if isRoute {
                let subtitle = item.subtitle.trimmingCharacters(in: .whitespacesAndNewlines)
                let fallback = item.title.replacingOccurrences(of: "Route ", with: "")
                let badgeNumber = item.routeNumber.isEmpty ? fallback : item.routeNumber
                cell.configureRoute(
                    title: routeName,
                    subtitle: subtitle.isEmpty ? nil : subtitle,
                    badgeImage: routeBadgeImage(number: badgeNumber, colorHex: item.routeColor)
                )
            } else {
                let subtitle = item.subtitle.trimmingCharacters(in: .whitespacesAndNewlines)
                cell.configureStop(
                    title: item.title,
                    subtitle: subtitle.isEmpty ? item.key : subtitle,
                    iconToken: item.stopIcon
                )
            }
            return cell
        }
    }

    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        defer { tableView.deselectRow(at: indexPath, animated: true) }
        guard let kind = SectionKind(rawValue: indexPath.section) else { return }

        if kind == .stops || kind == .routes {
            let sectionItems = kind == .stops ? stopItems : routeItems
            guard !sectionItems.isEmpty else { return }
            let item = sectionItems[indexPath.row]
            onAction?("open:\(item.key)")
            navigationController?.presentingViewController?.dismiss(animated: true)
            return
        }

        guard kind == .actions else { return }

        let alert = UIAlertController(
            title: "Clear All Favorites?",
            message: "This will remove all saved stops and routes from favorites.",
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        alert.addAction(UIAlertAction(title: "Clear", style: .destructive) { [weak self] _ in
            guard let self else { return }
            self.onAction?("clearAll")
            self.items = []
            self.stopItems = []
            self.routeItems = []
            self.tableView.reloadSections(IndexSet([SectionKind.stops.rawValue, SectionKind.routes.rawValue]), with: .automatic)
        })
        present(alert, animated: true)
    }

    override func tableView(_ tableView: UITableView, trailingSwipeActionsConfigurationForRowAt indexPath: IndexPath) -> UISwipeActionsConfiguration? {
        guard let kind = SectionKind(rawValue: indexPath.section) else { return nil }
        guard kind == .stops || kind == .routes else { return nil }

        let sectionItems = kind == .stops ? stopItems : routeItems
        guard !sectionItems.isEmpty else { return nil }
        let item = sectionItems[indexPath.row]

        let editAction = UIContextualAction(style: .normal, title: nil) { [weak self] _, _, completion in
            guard let self else {
                completion(false)
                return
            }
            self.presentEditSubtitle(for: item, kind: kind, row: indexPath.row)
            completion(true)
        }
        editAction.image = UIImage(systemName: "pencil")
        editAction.backgroundColor = .systemBlue

        let removeAction = UIContextualAction(style: .destructive, title: "Remove") { [weak self] _, _, completion in
            guard let self else {
                completion(false)
                return
            }
            self.onAction?("remove:\(item.key)")
            self.removeItem(kind: kind, at: indexPath.row)
            completion(true)
        }
        removeAction.backgroundColor = .systemRed

        let config = UISwipeActionsConfiguration(actions: [removeAction, editAction])
        config.performsFirstActionWithFullSwipe = true
        return config
    }

    private func prewarmSwipeActionsIfNeeded() {
        guard !didPrewarmSwipeActions else { return }
        didPrewarmSwipeActions = true
        if !stopItems.isEmpty || !routeItems.isEmpty {
            let feedback = UIImpactFeedbackGenerator(style: .light)
            feedback.prepare()
        }
        if !stopItems.isEmpty {
            _ = tableView(
                self.tableView,
                trailingSwipeActionsConfigurationForRowAt: IndexPath(row: 0, section: SectionKind.stops.rawValue)
            )
        }
        if !routeItems.isEmpty {
            _ = tableView(
                self.tableView,
                trailingSwipeActionsConfigurationForRowAt: IndexPath(row: 0, section: SectionKind.routes.rawValue)
            )
            for item in routeItems.prefix(12) {
                let fallback = item.title.replacingOccurrences(of: "Route ", with: "")
                let badgeNumber = item.routeNumber.isEmpty ? fallback : item.routeNumber
                _ = routeBadgeImage(number: badgeNumber, colorHex: item.routeColor)
            }
        }
    }

    func tableView(_ tableView: UITableView, itemsForBeginning session: UIDragSession, at indexPath: IndexPath) -> [UIDragItem] {
        guard let kind = SectionKind(rawValue: indexPath.section) else { return [] }
        guard kind == .stops || kind == .routes else { return [] }
        let sectionItems = kind == .stops ? stopItems : routeItems
        guard !sectionItems.isEmpty else { return [] }
        let item = sectionItems[indexPath.row]

        let provider = NSItemProvider(object: item.key as NSString)
        let dragItem = UIDragItem(itemProvider: provider)
        dragItem.localObject = item.key
        return [dragItem]
    }

    func tableView(_ tableView: UITableView, canHandle session: UIDropSession) -> Bool {
        return session.localDragSession != nil
    }

    func tableView(_ tableView: UITableView, dropSessionDidUpdate session: UIDropSession, withDestinationIndexPath destinationIndexPath: IndexPath?) -> UITableViewDropProposal {
        guard let destinationIndexPath else {
            return UITableViewDropProposal(operation: .cancel)
        }
        guard let kind = SectionKind(rawValue: destinationIndexPath.section), kind != .actions else {
            return UITableViewDropProposal(operation: .cancel)
        }
        return UITableViewDropProposal(operation: .move, intent: .insertAtDestinationIndexPath)
    }

    func tableView(_ tableView: UITableView, performDropWith coordinator: UITableViewDropCoordinator) {
        guard let item = coordinator.items.first,
              let source = item.sourceIndexPath else { return }

        let proposedDestination = coordinator.destinationIndexPath ?? source
        guard source.section == proposedDestination.section else { return }
        guard let kind = SectionKind(rawValue: source.section), kind != .actions else { return }

        if kind == .stops {
            guard !stopItems.isEmpty else { return }
            let destinationRow = max(0, min(proposedDestination.row, stopItems.count - 1))
            tableView.performBatchUpdates {
                let moved = stopItems.remove(at: source.row)
                stopItems.insert(moved, at: destinationRow)
                tableView.moveRow(at: source, to: IndexPath(row: destinationRow, section: source.section))
            }
            applyReorderAction(kind: .stops)
            coordinator.drop(item.dragItem, toRowAt: IndexPath(row: destinationRow, section: source.section))
        } else {
            guard !routeItems.isEmpty else { return }
            let destinationRow = max(0, min(proposedDestination.row, routeItems.count - 1))
            tableView.performBatchUpdates {
                let moved = routeItems.remove(at: source.row)
                routeItems.insert(moved, at: destinationRow)
                tableView.moveRow(at: source, to: IndexPath(row: destinationRow, section: source.section))
            }
            applyReorderAction(kind: .routes)
            coordinator.drop(item.dragItem, toRowAt: IndexPath(row: destinationRow, section: source.section))
        }
    }

    private func applyReorderAction(kind: SectionKind) {
        if kind == .stops {
            let keys = stopItems.map { $0.key }
            onAction?("reorderStops:\(keys.joined(separator: "|"))")
        } else if kind == .routes {
            let keys = routeItems.map { $0.key }
            onAction?("reorderRoutes:\(keys.joined(separator: "|"))")
        }
        items = stopItems + routeItems
    }

    private func routeBadgeImage(number: String, colorHex: String) -> UIImage? {
        let text = number.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return UIImage(systemName: "rectangle") }
        let routeColor = UIColor(hex: colorHex) ?? UIColor.systemBlue
        let cacheKey = "routeBadgeV4|\(text.lowercased())|\(routeColor.hexString)"
        if let cached = badgeImageCache[cacheKey] {
            return cached
        }

        let baseFont = UIFont.systemFont(ofSize: 25, weight: .bold)
        let fontDescriptor = baseFont.fontDescriptor.withDesign(.rounded) ?? baseFont.fontDescriptor
        let font = UIFont(descriptor: fontDescriptor, size: 25)
        let textAttributes: [NSAttributedString.Key: Any] = [
            .font: font,
            .foregroundColor: routeColor,
            .kern: -0.2
        ]
        let textSize = (text as NSString).size(withAttributes: textAttributes)
        let horizontalPadding: CGFloat = 16
        let verticalPadding: CGFloat = 7
        let width = max(74, ceil(textSize.width + horizontalPadding * 2))
        let height = ceil(textSize.height + verticalPadding * 2)
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: width, height: height))
        let image = renderer.image { context in
            let rect = CGRect(x: 1, y: 1, width: width - 2, height: height - 2)
            let corner: CGFloat = 12
            let path = UIBezierPath(roundedRect: rect, cornerRadius: corner)

            routeColor.withAlphaComponent(0.18).setFill()
            path.fill()

            let textRect = CGRect(
                x: (width - textSize.width) / 2,
                y: (height - textSize.height) / 2,
                width: textSize.width,
                height: textSize.height
            )
            routeColor.setFill()
            (text as NSString).draw(in: textRect, withAttributes: textAttributes)
        }
        let finalImage = image.withRenderingMode(.alwaysOriginal)
        badgeImageCache[cacheKey] = finalImage
        return finalImage
    }

    private func removeItem(kind: SectionKind, at row: Int) {
        if kind == .stops {
            guard row >= 0 && row < stopItems.count else { return }
            let removed = stopItems.remove(at: row)
            items.removeAll { $0.key == removed.key }
            if stopItems.isEmpty {
                tableView.reloadSections(IndexSet(integer: SectionKind.stops.rawValue), with: .automatic)
            } else {
                tableView.deleteRows(at: [IndexPath(row: row, section: SectionKind.stops.rawValue)], with: .automatic)
            }
            return
        }

        guard row >= 0 && row < routeItems.count else { return }
        let removed = routeItems.remove(at: row)
        items.removeAll { $0.key == removed.key }
        if routeItems.isEmpty {
            tableView.reloadSections(IndexSet(integer: SectionKind.routes.rawValue), with: .automatic)
        } else {
            tableView.deleteRows(at: [IndexPath(row: row, section: SectionKind.routes.rawValue)], with: .automatic)
        }
    }

    private func presentEditSubtitle(for item: FavoriteListItem, kind: SectionKind, row: Int) {
        let alertTitle = kind == .stops
            ? "Edit Stop Favorite\nIcon (one symbol/emoji)"
            : "Edit Secondary Text"
        let alert = UIAlertController(
            title: alertTitle,
            message: nil,
            preferredStyle: .alert
        )
        alert.addTextField { textField in
            textField.placeholder = "Secondary text"
            textField.text = item.subtitle
            textField.clearButtonMode = .whileEditing
            textField.autocapitalizationType = .sentences
        }
        if kind == .stops {
            let editableIcon = editableStopIconToken(item.stopIcon)
            alert.addTextField { textField in
                textField.placeholder = nil
                textField.text = editableIcon
                textField.clearButtonMode = .whileEditing
                textField.autocapitalizationType = .none
                textField.autocorrectionType = .no
                textField.spellCheckingType = .no
            }
        }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        alert.addAction(UIAlertAction(title: "Save", style: .default) { [weak self] _ in
            guard let self else { return }
            let fields = alert.textFields ?? []
            let newSubtitle = fields.first?.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            self.onAction?([
                "action": "editSubtitle",
                "key": item.key,
                "subtitle": newSubtitle
            ])
            self.updateSubtitleLocally(kind: kind, row: row, subtitle: newSubtitle)
            if kind == .stops {
                let enteredIcon = fields.count > 1 ? (fields[1].text ?? "") : ""
                let normalizedIcon = self.normalizeSingleSymbol(enteredIcon)
                let originalEditableIcon = self.editableStopIconToken(item.stopIcon)
                if normalizedIcon != originalEditableIcon {
                    self.onAction?([
                        "action": "editIcon",
                        "key": item.key,
                        "icon": normalizedIcon
                    ])
                    self.updateIconLocally(row: row, icon: normalizedIcon)
                }
            }
        })
        present(alert, animated: true)
    }

    private func normalizeSingleSymbol(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let firstCharacter = trimmed.first else { return "" }
        return String(firstCharacter)
    }

    private func editableStopIconToken(_ token: String) -> String {
        let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "" }
        if UIImage(systemName: trimmed) != nil {
            return ""
        }
        return normalizeSingleSymbol(trimmed)
    }

    private func updateSubtitleLocally(kind: SectionKind, row: Int, subtitle: String) {
        if kind == .stops {
            guard row >= 0 && row < stopItems.count else { return }
            let old = stopItems[row]
            let updated = FavoriteListItem(
                key: old.key,
                type: old.type,
                title: old.title,
                subtitle: subtitle,
                routeNumber: old.routeNumber,
                routeColor: old.routeColor,
                stopIcon: old.stopIcon
            )
            stopItems[row] = updated
            if let idx = items.firstIndex(where: { $0.key == old.key }) {
                items[idx] = updated
            }
            tableView.reloadRows(at: [IndexPath(row: row, section: SectionKind.stops.rawValue)], with: .none)
            return
        }

        guard row >= 0 && row < routeItems.count else { return }
        let old = routeItems[row]
        let updated = FavoriteListItem(
            key: old.key,
            type: old.type,
            title: old.title,
            subtitle: subtitle,
            routeNumber: old.routeNumber,
            routeColor: old.routeColor,
            stopIcon: old.stopIcon
        )
        routeItems[row] = updated
        if let idx = items.firstIndex(where: { $0.key == old.key }) {
            items[idx] = updated
        }
        tableView.reloadRows(at: [IndexPath(row: row, section: SectionKind.routes.rawValue)], with: .none)
    }

    private func updateIconLocally(row: Int, icon: String) {
        guard row >= 0 && row < stopItems.count else { return }
        let old = stopItems[row]
        let updated = FavoriteListItem(
            key: old.key,
            type: old.type,
            title: old.title,
            subtitle: old.subtitle,
            routeNumber: old.routeNumber,
            routeColor: old.routeColor,
            stopIcon: icon
        )
        stopItems[row] = updated
        if let idx = items.firstIndex(where: { $0.key == old.key }) {
            items[idx] = updated
        }
        tableView.reloadRows(at: [IndexPath(row: row, section: SectionKind.stops.rawValue)], with: .none)
    }
}

private extension UIColor {
    convenience init?(hex: String) {
        let raw = hex.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "#", with: "")
        let scanner = Scanner(string: raw)
        var value: UInt64 = 0
        guard scanner.scanHexInt64(&value) else { return nil }
        switch raw.count {
        case 6:
            self.init(
                red: CGFloat((value & 0xFF0000) >> 16) / 255.0,
                green: CGFloat((value & 0x00FF00) >> 8) / 255.0,
                blue: CGFloat(value & 0x0000FF) / 255.0,
                alpha: 1.0
            )
        case 8:
            self.init(
                red: CGFloat((value & 0xFF000000) >> 24) / 255.0,
                green: CGFloat((value & 0x00FF0000) >> 16) / 255.0,
                blue: CGFloat((value & 0x0000FF00) >> 8) / 255.0,
                alpha: CGFloat(value & 0x000000FF) / 255.0
            )
        default:
            return nil
        }
    }

    var hexString: String {
        var red: CGFloat = 0
        var green: CGFloat = 0
        var blue: CGFloat = 0
        var alpha: CGFloat = 0
        guard getRed(&red, green: &green, blue: &blue, alpha: &alpha) else { return "#000000" }
        let r = Int(round(red * 255))
        let g = Int(round(green * 255))
        let b = Int(round(blue * 255))
        return String(format: "#%02X%02X%02X", r, g, b)
    }
}

final class FavoriteItemCell: UITableViewCell {
    private let iconView = UIImageView()
    private let iconLabel = UILabel()
    private let titleLabel = UILabel()
    private let subtitleLabel = UILabel()
    private var iconWidthConstraint: NSLayoutConstraint?
    private var iconHeightConstraint: NSLayoutConstraint?

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)
        setupViews()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        setupViews()
    }

    private func setupViews() {
        iconView.translatesAutoresizingMaskIntoConstraints = false
        iconView.contentMode = .scaleAspectFit
        iconView.setContentHuggingPriority(.required, for: .horizontal)
        iconView.setContentCompressionResistancePriority(.required, for: .horizontal)
        contentView.addSubview(iconView)

        iconLabel.translatesAutoresizingMaskIntoConstraints = false
        iconLabel.font = .systemFont(ofSize: 23)
        iconLabel.textAlignment = .center
        iconLabel.setContentHuggingPriority(.required, for: .horizontal)
        iconLabel.setContentCompressionResistancePriority(.required, for: .horizontal)
        iconLabel.isHidden = true
        contentView.addSubview(iconLabel)

        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        titleLabel.font = .preferredFont(forTextStyle: .body)
        titleLabel.textColor = .label
        titleLabel.numberOfLines = 0
        titleLabel.lineBreakMode = .byWordWrapping
        contentView.addSubview(titleLabel)

        subtitleLabel.translatesAutoresizingMaskIntoConstraints = false
        subtitleLabel.font = .preferredFont(forTextStyle: .footnote)
        subtitleLabel.textColor = .secondaryLabel
        subtitleLabel.numberOfLines = 1
        contentView.addSubview(subtitleLabel)

        NSLayoutConstraint.activate([
            iconView.leadingAnchor.constraint(equalTo: contentView.layoutMarginsGuide.leadingAnchor),
            iconView.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 10),
            iconLabel.leadingAnchor.constraint(equalTo: iconView.leadingAnchor),
            iconLabel.topAnchor.constraint(equalTo: iconView.topAnchor),
            iconLabel.widthAnchor.constraint(equalTo: iconView.widthAnchor),
            iconLabel.heightAnchor.constraint(equalTo: iconView.heightAnchor),
        ])
        iconWidthConstraint = iconView.widthAnchor.constraint(equalToConstant: 28)
        iconHeightConstraint = iconView.heightAnchor.constraint(equalToConstant: 28)
        iconWidthConstraint?.isActive = true
        iconHeightConstraint?.isActive = true

        NSLayoutConstraint.activate([

            titleLabel.leadingAnchor.constraint(equalTo: iconView.trailingAnchor, constant: 14),
            titleLabel.trailingAnchor.constraint(equalTo: contentView.layoutMarginsGuide.trailingAnchor),
            titleLabel.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 8),

            subtitleLabel.leadingAnchor.constraint(equalTo: titleLabel.leadingAnchor),
            subtitleLabel.trailingAnchor.constraint(equalTo: titleLabel.trailingAnchor),
            subtitleLabel.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: 2),
            subtitleLabel.bottomAnchor.constraint(lessThanOrEqualTo: contentView.bottomAnchor, constant: -8)
        ])
    }

    func configureStop(title: String, subtitle: String?, iconToken: String) {
        titleLabel.text = title
        subtitleLabel.text = subtitle
        subtitleLabel.isHidden = (subtitle == nil || subtitle?.isEmpty == true)
        let token = iconToken.trimmingCharacters(in: .whitespacesAndNewlines)
        if token.isEmpty {
            iconView.image = UIImage(systemName: "mappin.circle")
            iconView.tintColor = .secondaryLabel
            iconLabel.text = nil
            iconLabel.isHidden = true
        } else if let symbol = UIImage(systemName: token) {
            iconView.image = symbol
            iconView.tintColor = .secondaryLabel
            iconLabel.text = nil
            iconLabel.isHidden = true
        } else {
            iconView.image = nil
            iconView.tintColor = nil
            iconLabel.text = token
            iconLabel.isHidden = false
        }
        iconView.contentMode = .scaleAspectFit
        iconWidthConstraint?.constant = 28
        iconHeightConstraint?.constant = 28
    }

    func configureRoute(title: String, subtitle: String?, badgeImage: UIImage?) {
        titleLabel.text = title
        subtitleLabel.text = subtitle
        subtitleLabel.isHidden = (subtitle == nil || subtitle?.isEmpty == true)
        iconView.image = badgeImage
        iconView.tintColor = nil
        iconLabel.text = nil
        iconLabel.isHidden = true
        iconView.contentMode = .scaleAspectFit
        iconWidthConstraint?.constant = badgeImage?.size.width ?? 74
        iconHeightConstraint?.constant = badgeImage?.size.height ?? 46
    }
}

// MARK: - Theme Segment Cell

final class ThemeSegmentCell: UITableViewCell {
    
    private let segmentedControl = UISegmentedControl(items: ["Auto", "Light", "Dark"])
    private var onChange: ((String) -> Void)?
    
    private let themeOptions = ["system", "light", "dark"]
    
    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)
        setupViews()
    }
    
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }
    
    private func setupViews() {
        selectionStyle = .none
        
        segmentedControl.translatesAutoresizingMaskIntoConstraints = false
        segmentedControl.addTarget(self, action: #selector(segmentChanged), for: .valueChanged)
        contentView.addSubview(segmentedControl)
        
        NSLayoutConstraint.activate([
            segmentedControl.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 16),
            segmentedControl.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -16),
            segmentedControl.centerYAnchor.constraint(equalTo: contentView.centerYAnchor)
        ])
    }
    
    func configure(selectedTheme: String, onChange: @escaping (String) -> Void) {
        self.onChange = onChange
        
        if let index = themeOptions.firstIndex(of: selectedTheme) {
            segmentedControl.selectedSegmentIndex = index
        } else {
            segmentedControl.selectedSegmentIndex = 0
        }
    }
    
    @objc private func segmentChanged() {
        let index = segmentedControl.selectedSegmentIndex
        guard index >= 0, index < themeOptions.count else { return }
        onChange?(themeOptions[index])
    }
}

// MARK: - Scale Slider Cell

final class ScaleSliderCell: UITableViewCell {
    
    private let valueLabel = UILabel()
    private let slider = UISlider()
    private var onChange: ((Float) -> Void)?
    private var step: Float = 0.05
    
    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)
        setupViews()
    }
    
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }
    
    private func setupViews() {
        selectionStyle = .none
        
        valueLabel.font = .monospacedDigitSystemFont(ofSize: 15, weight: .medium)
        valueLabel.textColor = .secondaryLabel
        valueLabel.textAlignment = .right
        valueLabel.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(valueLabel)
        
        slider.translatesAutoresizingMaskIntoConstraints = false
        slider.addTarget(self, action: #selector(sliderChanged), for: .valueChanged)
        slider.addTarget(self, action: #selector(sliderEnded), for: [.touchUpInside, .touchUpOutside])
        contentView.addSubview(slider)
        
        NSLayoutConstraint.activate([
            slider.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 16),
            slider.centerYAnchor.constraint(equalTo: contentView.centerYAnchor),
            
            valueLabel.leadingAnchor.constraint(equalTo: slider.trailingAnchor, constant: 12),
            valueLabel.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -16),
            valueLabel.centerYAnchor.constraint(equalTo: contentView.centerYAnchor),
            valueLabel.widthAnchor.constraint(equalToConstant: 50)
        ])
    }
    
    func configure(value: Float, minValue: Float, maxValue: Float, step: Float, onChange: @escaping (Float) -> Void) {
        self.onChange = onChange
        self.step = step
        
        slider.minimumValue = minValue
        slider.maximumValue = maxValue
        slider.value = value
        
        updateValueLabel(value)
    }
    
    private func updateValueLabel(_ value: Float) {
        let percentage = Int(round(value * 100))
        valueLabel.text = "\(percentage)%"
    }
    
    private func snapToStep(_ value: Float) -> Float {
        return round(value / step) * step
    }
    
    @objc private func sliderChanged() {
        let snapped = snapToStep(slider.value)
        updateValueLabel(snapped)
    }
    
    @objc private func sliderEnded() {
        let snapped = snapToStep(slider.value)
        slider.value = snapped
        updateValueLabel(snapped)
        onChange?(snapped)
    }
}
