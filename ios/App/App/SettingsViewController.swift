import UIKit

final class SettingsViewController: UITableViewController {
    
    // MARK: - Item Types
    
    enum ItemType {
        case toggle
        case themeSegment // Auto / Light / Dark
        case scaleSlider  // 0.8 - 1.5
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
        Section(title: "Routes", items: [
            Item(key: "simplifyNumbers", title: "Simplify Route Numbers", icon: "numbers.rectangle"),
            Item(key: "showMinibuses", title: "Show Minibuses"),
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
        ])
    ]

    private var boolValues: [String: Bool] = [:]
    private var themeValue: String = "system"
    private var scaleValue: Float = 1.0
    
    private let scaleMin: Float = 0.8
    private let scaleMax: Float = 1.5
    private let scaleStep: Float = 0.05

    var onToggle: ((String, Any) -> Void)?
    var onDone: (([String: Any]) -> Void)?

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
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
        let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?"
        
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

    @objc private func doneTapped() {
        onDone?(getAllSettings())
        dismiss(animated: true)
    }

    override func numberOfSections(in tableView: UITableView) -> Int {
        sections.count
    }

    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        sections[section].items.count
    }

    override func tableView(_ tableView: UITableView, titleForHeaderInSection section: Int) -> String? {
        sections[section].title
    }
    
    override func tableView(_ tableView: UITableView, heightForRowAt indexPath: IndexPath) -> CGFloat {
        let item = sections[indexPath.section].items[indexPath.row]
        switch item.type {
        case .themeSegment:
            return 44
        case .scaleSlider:
            return 44
        case .toggle:
            return UITableView.automaticDimension
        }
    }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let item = sections[indexPath.section].items[indexPath.row]
        
        switch item.type {
        case .toggle:
            let cell = tableView.dequeueReusableCell(withIdentifier: "ToggleCell", for: indexPath)
            cell.selectionStyle = .none
            cell.textLabel?.text = item.title
            
            // Set icon
            if let iconName = item.icon {
                cell.imageView?.image = UIImage(systemName: iconName)
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

    @objc private func toggleChanged(_ sender: UISwitch) {
        guard let key = sender.accessibilityIdentifier else { return }
        boolValues[key] = sender.isOn
        onToggle?(key, sender.isOn)
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
