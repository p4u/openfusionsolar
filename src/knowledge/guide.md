# Domain guide for the household energy assistant

Scope: households in Catalonia with grid-tied PV, a Huawei SUN2000 hybrid inverter, optionally a LUNA2000 battery, a Huawei smart power sensor and a 2.0TD access tariff, usually with simplified compensation of surplus. Supplier examples use Som Energia's published prices and rules (including Flux Solar). Written for an assistant that answers non-technical users in Catalan or English. The guide knows nothing about a particular household: for the user's own plant, contract and bills, use the app's data.

How to use: each `###` block is self-contained and can be fetched by its id. Numbers in brackets point to the source list at the end. "[unverified]" means no primary source was found; say so to the user. Worked examples marked "Example" use invented numbers; they show the method, not anyone's real figures. All sources accessed 2026-11-20. Rules and prices change: when a user asks about a date, check the "applies from" or "as of" note, and give that date with the figure.

House rules for answers:
- Plain words first, the number second, the caveat third.
- Never tell a user to open the inverter, battery or meter, or to change grid-protection settings. Send them to the installer.
- Say "I don't know" when a figure is marked unverified or depends on data the app does not have.

---

## pv-basics

How panels, inverter and battery work; energy terms; why output varies.

### pv-basics/how-it-works
Panels turn sunlight into direct current; the inverter turns it into household alternating current. In a Huawei "maximum self-consumption" setup, solar power goes first to the house, surplus charges the battery, and only when the battery is full or charging at its limit does the rest go to the grid; at night the battery feeds the house [4]. The grid fills any gap. The smart power sensor at the connection point measures what is bought from and sent to the grid, which lets the system steer the battery and compute house consumption [10].

The utility meter (owned by the distributor) is what the bill uses, not the Huawei app. It records energy hour by hour, and for billing the hourly import and export are netted inside each hour ("balanç net horari") before compensation is applied [38] (rule as of 2026-11-20).

### pv-basics/self-consumption-terms
Four flows describe the system:
- Production (yield): energy made by the panels/inverter.
- Self-consumption: production used in the house directly or via the battery.
- Export (feed-in, "excedents", "abocament"): production sent to the grid.
- Import (supply from grid): energy bought from the grid.

Huawei's logger computes daily consumption as yield + grid import − grid export (battery flows adjust it) [10]. Two ratios follow, and the app reports both [4]:
- Self-consumption rate = self-consumed ÷ produced. "How much of my solar did I use?"
- Self-sufficiency rate = self-consumed ÷ total consumption. "How much of my house ran on my own solar?"

A big system in summer can have high self-sufficiency and low self-consumption at the same time. That is normal: the house is covered and the rest is exported.

### pv-basics/kw-vs-kwh
- kW (kilowatt) is power: how hard something is pulling at one moment, like speed. An oven might draw 2 kW. Contracted power (e.g. 3.45 kW) is a cap on how much can run at once [16].
- kWh (kilowatt-hour) is energy: how much was used over time, like distance. That oven for 30 minutes uses about 1 kWh. Bills charge kWh for energy and kW per year for power [12].
- kWp (kilowatt-peak) is the panels' rated power under standard test conditions. Real output is almost always below it (see pv-basics/why-production-varies).

Analogy for users: kW is the width of the pipe, kWh is the water that went through it.

### pv-basics/why-production-varies
- Season and sun height: winter days are short and the sun is low, so a south-facing roof in Catalonia makes a little over half of its July energy in December (see pv-basics/catalonia-yields) [1].
- Weather: clouds cut output within minutes; the PVGIS estimate for one site varies about 3% year to year in annual total [1].
- Temperature: hot panels produce less than cold ones at the same sunlight. PVGIS includes temperature and low-light losses in its estimates; for the reference site and setup in pv-basics/catalonia-yields, total modelled losses are about 21% relative to the nominal value [1]. Typical crystalline modules lose around 0.3-0.35% per °C above 25 °C [unverified: secondary source; check the module datasheet].
- Shading: chimneys, trees, mountains (PVGIS uses a terrain horizon by default) [1]. Shading of one panel can pull down a whole string unless optimisers are fitted [unverified].
- Soiling: dust, pollen and bird droppings reduce output until rain or cleaning [unverified magnitude].
- Orientation and tilt: east or west roofs make about 20% less per year than south at the reference site, and much less in winter (see pv-basics/catalonia-yields) [1].
- Inverter clipping: when the panels could deliver more DC power than the inverter's AC rating, the inverter caps output; this only happens around midday on very clear days and depends on the panel-to-inverter ratio [3]. Example: 4 kWp of panels on a 5 kW inverter (ratio below 1) should rarely clip [unverified in practice].
- Export limits and battery behaviour can also cap what leaves the house (see huawei-fusionsolar).

### pv-basics/catalonia-yields
PVGIS (EU Joint Research Centre) estimate for 1 kWp at a reference site in Barcelona (41.39 N, 2.17 E), crystalline silicon, 14% system loss, PVGIS-SARAH3 radiation 2005-2023 [1]. Other places in Catalonia differ by a few percent. kWh per kWp per month:

| Month | South 30° | East 30° | West 30° |
|---|---|---|---|
| Jan | 101 | 53 | 55 |
| Feb | 105 | 66 | 67 |
| Mar | 136 | 101 | 104 |
| Apr | 143 | 120 | 124 |
| May | 160 | 148 | 151 |
| Jun | 162 | 155 | 159 |
| Jul | 167 | 156 | 162 |
| Aug | 157 | 135 | 142 |
| Sep | 131 | 103 | 106 |
| Oct | 112 | 75 | 79 |
| Nov | 92 | 53 | 54 |
| Dec | 92 | 47 | 46 |
| Year | 1,558 | 1,211 | 1,248 |

How to use it: multiply by the plant's kWp. Example: a 3 kWp south-facing array would make roughly 4,700 kWh a year: about 5.4 kWh per kWp per day in July and 3.0 in December. These are long-term averages; one month can be 20-30% off without anything being wrong [1]. The guide does not know a plant's orientation and tilt, so compare the app's actual numbers with the column that matches the roof, or with the plant's own previous years.

### pv-basics/degradation
Panels slowly lose output. A review of nearly 2,000 measured degradation rates found a median of 0.5% per year [2]. Over 10 years that is about 5% less, which is small next to normal weather variation. A sudden drop (10% or more month-on-month against the same weather) is not degradation; it points to shading, soiling, a fault or an alarm, and the installer should check it.

Batteries also age. Huawei rates the LUNA2000-S0 for more than 5,000 cycles and 80% state of health after 10 years, under a 35% depth-of-discharge test condition [7]; warranty terms are in a separate warranty letter [7].

---

## huawei-fusionsolar

Huawei inverter and battery: modes, settings, alarms, power cuts.

### huawei-fusionsolar/working-modes
The battery's "working mode" (Huawei: ESS control) has three main options [4]:
- Maximum self-consumption: solar feeds loads first, then the battery, then the grid. At night or when solar is short, the battery feeds the house. The grid cannot charge the battery in this mode [4].
- Time-of-use (TOU): the user sets charge and discharge time slots (up to 14 segments, with repeat days). In charge slots the grid and panels charge the battery; in discharge slots the battery supplies loads. Outside the defined slots the battery neither charges nor discharges [4]. TOU turns on "Charge from AC" [6].
- Fully fed to grid: maximises export; the battery only stores what the inverter cannot pass through and releases it later. The grid cannot charge the battery [4]. Not useful for a household with simplified compensation, because exported energy is paid at a low price (see self-consumption-compensation/surplus-prices).

Huawei notes that charging from and discharging to the grid "are restricted by local laws and regulations" [4]. Whether grid charging is allowed for a given connection is not confirmed here [unverified]; ask the installer before enabling it.

### huawei-fusionsolar/soc-settings
SOC (state of charge) is the battery's fill level in %. Key settings [4][5][6]:
- End-of-charge SOC: upper limit, settable 90-100% [6].
- End-of-discharge SOC: the floor in normal use, settable 0-20%; Huawei's default for LUNA2000 is 5% [6].
- Backup power SOC (only with a backup box / off-grid mode): energy kept for power cuts. It has priority over end-of-discharge SOC: with end-of-discharge 10% and backup 20%, the battery stops feeding the house at 20% [5].
- Grid charge cutoff SOC: how full the grid may charge the battery; only acts in TOU mode [4].
- Maximum charge power of grid: cap on grid charging power; the actual value is the lower of the inverter's capability and what the grid operator allows [4].
- Peak shaving: optional mode that needs "Charge from AC" on; it keeps a reserve ("Backup power SOC for peak shaving") to cap power drawn from the grid at a set "Peak Power" [4]. Whether a given firmware offers it is [unverified].

Plain trade-off: a higher floor means more reserve for outages and less daily saving; a lower floor means more daily saving.

### huawei-fusionsolar/battery-at-minimum
Common, normal reasons the battery sits at its floor:
- It has reached end-of-discharge SOC (default 5%) or backup SOC, whichever is higher [5][6].
- No sun for a long time: if no PV is installed or no sunlight has been detected for at least 24 hours, the minimum end-of-discharge SOC becomes 15% [7].
- Winter: the panels may produce less than the house uses during the day, so there is no surplus to charge the battery (see pv-basics/catalonia-yields).
- In TOU mode, outside a discharge slot the battery does not discharge at all [4].
- Battery health check / calibration: Huawei runs periodic checks that change charge/discharge behaviour while running [6].
- In off-grid operation, Huawei warns when remaining dischargeable capacity falls below 10% (alarm 2094) [8].

If the battery never charges on a sunny day, or alarm 2068 "Battery abnormal" appears, that is a fault for the installer [8].

### huawei-fusionsolar/battery-specs
LUNA2000-5/10/15-S0 datasheet [7]:
- Usable capacity 5/10/15 kWh (test at 100% depth of discharge, 0.2C, 25 °C, beginning of life).
- Charge/discharge power 2.5 kW (5 kWh) or 5 kW (10 and 15 kWh); short peaks up to 3.74 or 7 kW for 5 s.
- More than 5,000 cycles, 80% state of health after 10 years (35% DoD condition).

Round-trip efficiency (energy out ÷ energy in) is not published in the datasheet [unverified]. Estimate it from the plant's own data: over a month, total battery discharge kWh ÷ total charge kWh (start and end SOC similar). The installed capacity and model come from the app's device data, not from this guide.

### huawei-fusionsolar/power-cut
A grid-tied solar system stops when the grid goes down. Spanish rules (RD 1699/2011, in force as of 2026-11-20) forbid injecting power into a dead line, to protect line workers [11]. So without extra equipment, a power cut means no solar and no battery in the house, even on a sunny day.

Backup needs a Huawei Backup Box (or equivalent) and "off-grid mode" enabled. Then, when the grid fails, the system switches to backup and powers only the backup-circuit loads; when the grid returns it switches back automatically if "automatic switching" is set [5]. Backup time depends on the battery SOC at the moment of the cut [5]. Overloading the backup output raises alarm 2077 "Off-grid output overload"; remove some loads, then clear the alarm [8]. Inverter LEDs steady orange mean off-grid operation [9].

Whether a plant has a backup box is not known to this guide; the assistant should ask or check the device list, and not promise backup.

### huawei-fusionsolar/alarms
From Huawei's inverter alarm reference [8]. Plain meaning and what the user should do:

| ID | Name | What it means | User action |
|---|---|---|---|
| 2032 | Grid Failure | Grid outage, or AC cable/breaker off | If the whole street is out, wait. If only the inverter: installer. Do not just flip the AC breaker back on; Huawei says check impedance first [8] |
| 2033/2034 | Grid Under/Overvoltage | Grid voltage outside limits | Occasional: self-recovers. Frequent: installer/distributor [8] |
| 2036/2037 | Grid Over/Underfrequency | Grid frequency outside limits | Same as above [8] |
| 2062 | Low Insulation Resistance | Leak to ground in panels/cables (often damp mornings) or battery rack | Occasional after rain/dew is common; repeated: installer [8] |
| 2051 | Abnormal Residual Current | Insulation drops during operation | Occasional: self-recovers; frequent: installer [8] |
| 2011 | String Reverse Connection | A panel string is wired backwards | Installer only [8] |
| 2065 | Update Failure or Version Mismatch | Firmware update failed | Retry; if repeated, vendor support [8] |
| 2068 | Battery abnormal | Battery fault, lost communication, breaker off | Installer [8] |
| 2077 | Off-Grid Output Overload | Too much load on backup | Switch off loads, clear alarm [8] |
| 2094 | Battery remaining capacity low | Under 10% in off-grid | Reduce loads [8] |

The reference is written for technical engineers [8]; translate, don't instruct repairs.

### huawei-fusionsolar/app-and-portal
The FusionSolar app and web portal show energy flow (panels, battery, house, grid), yield, consumption, grid import and export, battery SOC, and the self-consumption and self-sufficiency rates [4][10]. Daily values reset at midnight from cumulative meter counters [10]. Differences with the bill are normal: the bill uses the distributor's meter with hourly netting and billing periods that may not match calendar days [38][12].

Firmware: alarm 2065 shows Huawei expects updates to fail occasionally and be retried [8]. How updates are delivered to a given plant (automatic, installer-pushed or user-triggered) is [unverified]. Settings changes (working mode, SOC) in the FusionSolar app usually need installer rights [unverified].

---

## spain-tariff-2.0TD

The household access tariff: periods, bill lines, power, taxes.

### spain-tariff-2.0TD/periods
2.0TD applies to low-voltage supplies up to 15 kW; it has 3 energy periods and 2 power periods [12][48]. Applies since 1 June 2021 [12]:

| Energy period | Weekdays (Mon-Fri) | Weekends and national holidays |
|---|---|---|
| P1 punta (peak) | 10-14 h and 18-22 h | none |
| P2 pla / llano (mid) | 8-10 h, 14-18 h, 22-24 h | none |
| P3 vall / valle (off-peak) | 0-8 h | all 24 hours |

Power periods: P1 "punta-pla" 8-24 h on weekdays; P2 "vall" 0-8 h on weekdays plus all of Saturdays, Sundays and national holidays [12]. Holidays that count are national ones only, excluding movable and substitutable holidays [12]; Catalan regional and local holidays are normal weekdays for the tariff [12].

Solar hours fall mostly in P1 and P2 on weekdays and in P3 on weekends.

### spain-tariff-2.0TD/bill-structure
A 2.0TD bill has these blocks [12][26]:
1. Power term ("terme de potència"): kW contracted × €/kW·year × days/365, for each power period. Paid whether or not you use electricity.
2. Energy term ("terme d'energia"): kWh used in each period × €/kWh.
3. Supplier extras: Som Energia bills REE adjustment services ("serveis d'ajust") separately, about 0.025 €/kWh (last month's average, as of 2026-11-20) [26].
4. Bono social financing: a fixed daily amount, 0.024688 €/day since 1 July 2026 [26][29].
5. Electricity tax (impost elèctric) on the sum of the above.
6. Meter rental (lloguer del comptador), per day.
7. VAT (IVA) on everything above.

Som's 2.0TD "períodes" prices from 1 Oct 2026, before taxes: energy P1 0.249, P2 0.169, P3 0.150 €/kWh; power P1 29.934 and P2 2.955 €/kW·year; surplus compensation 0.0300 €/kWh [26]. These already include tolls and charges [26].

### spain-tariff-2.0TD/peajes-cargos
Inside every price are regulated parts:
- Peatges (peajes, tolls) pay for transmission and distribution networks; set yearly by the CNMC [12][13].
- Càrrecs (cargos, charges) pay other system costs (renewable support, past deficits, island generation) and are set by the Ministry [12][14].

Values for 2.0TD from 1 January 2026 [12][13][14][15]:

| | P1 | P2 | P3 |
|---|---|---|---|
| Toll, power (€/kW·year) | 23.324952 | 0.443770 | - |
| Charge, power (€/kW·year) | 4.379461 | 0.281653 | - |
| Toll, energy (€/kWh) | 0.033261 | 0.016409 | 0.000077 |
| Charge, energy (€/kWh) | 0.064292 | 0.012858 | 0.003215 |

So of Som's P1 energy price of 0.249 €/kWh, about 0.098 €/kWh is regulated tolls and charges, versus about 0.003 €/kWh in P3 [13][14][26]. That is the main reason P1 is expensive even when the wholesale price is near zero at midday (see spain-market/daily-shape).

### spain-tariff-2.0TD/power-control
Smart meters ("comptador de telegestió") include the power-control switch (ICP), so an old ICP in the fuse box is no longer required [18]. If demand exceeds the contracted power, the meter cuts supply; to restore it, unplug the culprit appliance, switch the main breaker off, wait 3 seconds and switch it on, or press the meter button [18].

Som says there is some tolerance: demand may exceed contracted power by 50% for up to 15 minutes [16] [unverified against regulation; behaviour can vary by meter and distributor]. Maximum demand shown on bills and distributor portals is a 15-minute average, so short spikes (motors starting) do not show up [16].

Maximeter ("maxímetre") billing, where excess demand is charged instead of cut, applies to 2.0TD only for supplies with non-interruptible loads (e.g. lifts) and to 3.0TD and above [16]. When excess-power billing applies, from 1 January 2026 the 2.0TD toll excess price is 0.279426 €/kW·day in P1 and 0.005316 €/kW·day in P2, plus a 20% surcharge [12]. Most household 2.0TD contracts are controlled by the meter's ICP, not by maximeter [16].

### spain-tariff-2.0TD/change-power
Rules and costs as of 2026-11-20:
- Steps: any multiple of 0.1 kW (e.g. 4.1, 4.2, 4.3 kW); the old fixed steps no longer apply [16]. P1 and P2 can be different [12].
- How: Som Oficina Virtual > Contractes > Modificar potència; takes effect in 1-3 weeks [17].
- Cost of lowering (or changing a period without raising the maximum): 10.94 € including VAT, charged by the distributor through the bill [17].
- Cost of raising the maximum: 10.94 € plus 44.86 € per kW added, including VAT [17]. Breakdown before VAT: access rights 19.703137 €/kW, extension rights 17.374714 €/kW (only above what the connection already has), connection fee 9.04476 € [19]. Raising back to a level you had in the last 3 years costs 23.84 €/kW instead of 44.86 [17].
- Limit: distributors only have to accept one power change every 12 months (RD 1955/2000); in practice most refuse a reduction within 12 months of any change [17].
- A higher request may need a new electrical certificate ("butlletí") if it is older than 20 years or below the new power [17].
- Som's advice: if lowering, lower only P1 and keep P2 (vall) power, because P2 power is very cheap and keeps your access rights [16].

Value of 0.1 kW less in P1 at Som prices from 1 Oct 2026: 0.1 × 29.934 = about 3.0 €/year before taxes, about 3.8 € with 5.11% tax and 21% VAT [26].

### spain-tariff-2.0TD/electricity-tax
Impost especial sobre l'electricitat (IEE). Normal rate 5.11269632% (as of 2026-11-20) [20][21]. Minimum amounts: 1 €/MWh for household uses, 0.5 €/MWh for industrial uses [20].

Example: on a taxable base of 40.00 €, the tax at the normal rate is 40.00 × 5.11269632% = 2.05 €. Which bill lines form the base (power, energy, extras, compensation) is not checked against the tax law here [unverified].

2026 temporary reductions (month by month, per the Tax Agency) [21]:
- 22 March - 31 May 2026: 0.5% (RDL 7/2026) [20][21].
- June and July: 5.11269632% (the April electricity CPI condition was not met) [21].
- August and September: 5.11269632% (RDL 18/2026 allowed a return to 0.5% only if prices rose >15%; condition not met) [21].
- October: 5.11269632% [21].
- November and December: 5.11269632% (RDL 25/2026 safeguard, CPI condition not met) [21][24].

### spain-tariff-2.0TD/vat
IVA on household electricity [20][22][23][25][26]:
- Normal rate: 21%.
- 22 March - 31 May 2026: 10% for contracts with contracted power up to 10 kW, and for bono social recipients classed as severe vulnerable or at risk of exclusion (RDL 7/2026, Art. 42) [20]. RDL 10/2026 (28 April) only clarified the wording ("equal to or below 10 kW") without changing the content [25].
- From 1 June 2026: back to 21% [22].
- RDL 18/2026 (29 June) allowed a return to the reduced rate if gas and electricity prices rose; it was not triggered [22][24].
- RDL 25/2026 (29 Sept) sets 10% for November and December 2026 only if the electricity and gas CPI of September (for November) or October (for December) exceeds the same month of 2025 by more than 15 points [23].
- Status for November 2026: Som Energia's tariff page, read on 2026-11-20, lists VAT 21% and electricity tax 5.11% [26], and the Tax Agency says the parallel electricity-tax condition was not met for November and December [21]. Treat November as 21%. A Tax Agency statement specific to VAT for November/December was not found [unverified].

### spain-tariff-2.0TD/meter-rental-and-social-bonus
Meter rental: the regulated price for a single-phase household smart meter with time discrimination and remote reading is 0.81 €/month (Orden ITC/3860/2007, as of 2026-11-20) [30][26]. Three-phase meters cost more; their regulated price was not confirmed here [unverified].

Bono social (bo social) has two sides:
- Every bill pays a financing charge: 0.024688 €/day since 1 July 2026 (it was 0.019121 €/day before) [26][29].
- Eligible vulnerable households get a discount, only on the PVPC regulated tariff with up to 10 kW [27][28]. In 2026 the discount is 42.5% for vulnerable and 57.5% for severe vulnerable consumers, set by RDL 7/2026 [27]; the Ministry says it reverts to 35% and 50% when the exceptional period ends, with the 57.5% stated until 31 December 2026 [28]. The discount applies up to a capped amount of energy per billing period; energy above it is billed at PVPC without discount [27]. A Som Energia contract (free market) cannot receive the bono social discount [27].

---

## spain-market

Prices: PVPC or free market, price formation, daily shape.

### spain-market/pvpc-vs-free
- PVPC (preu voluntari per al petit consumidor, regulated tariff): only from "reference suppliers"; same rules nationwide; for individuals and micro-businesses with up to 10 kW in each period and up to 1 kV (as of 2026-11-20) [31]. It moves every hour [31].
- Free market (mercat lliure): any supplier, any price structure the contract states: fixed per period (like Som "períodes"), indexed to the wholesale price, flat, etc. [26][39].

Som Energia is a free-market supplier; its "períodes" tariff has fixed prices per period, revised from time to time, and an indexed tariff also exists where compensation is the hourly OMIE price [26][39]. The bono social discount is PVPC-only [27].

### spain-market/pvpc-formation
The PVPC energy price is built from [31][33]:
1. Day-ahead and intraday wholesale market price (OMIE).
2. Since 2024, a futures term (see below).
3. Adjustment services (REE balancing costs).
4. Capacity payments and other regulated costs.
5. Tolls and charges (see spain-tariff-2.0TD/peajes-cargos).
6. Commercialisation cost (reference supplier's costs and margin).

2024 reform (Royal Decree approved 13 June 2023, in force 1 January 2024): part of the energy cost is tied to futures markets to reduce volatility. Weight of futures: 25% in 2024, 40% in 2025, 55% in 2026. The futures basket is 10% monthly, 36% quarterly and 54% annual products [32]. The hourly signal is kept: the day-ahead hourly spread is still passed through, so cheap hours stay cheap [32]. Since 1 January 2024 the PVPC is limited to households and micro-businesses up to 10 kW [32].

### spain-market/where-to-read-prices
Official hourly prices come from REE's open API, no key needed [34]:

`https://apidatos.ree.es/es/datos/mercados/precios-mercados-tiempo-real?start_date=YYYY-MM-DDT00:00&end_date=YYYY-MM-DDT23:59&time_trunc=hour`

It returns two series in €/MWh (divide by 1,000 for €/kWh) [34]:
- "PVPC": the hourly PVPC energy price for 2.0TD (24 values per day) [33][34].
- "Precio mercado spot": the day-ahead wholesale price, now in 15-minute steps (96 values per day) [34][36].

ESIOS shows the PVPC split into its components (market, adjustment services, commercialisation, capacity) [33]. The day-ahead market moved from hourly to 15-minute products on 1 October 2025 [36].

Caution: the spot price is not what a Som "períodes" customer pays. It matters for indexed contracts and explains why surplus is valued low (see self-consumption-compensation/surplus-prices).

### spain-market/daily-shape
Typical shape with lots of solar in the system: wholesale prices fall to near zero in the middle of the day and peak in the evening when the sun sets and demand is high [34][39]. Som explains that solar-hour wholesale prices have dropped relative to the rest of the day because of the volume of solar generation [39].

Examples from REE data [34]:
- Thursday 19 Nov 2026: spot about 0 €/MWh from 10 to 15 h, 110-134 €/MWh from 18 to 21 h. PVPC was about 176 €/MWh at 10-13 h (P1), 107 at 14-16 h (P2), and 302-328 at 18-21 h (P1). Midday PVPC stayed high because P1 tolls and charges apply even when energy is almost free (see spain-tariff-2.0TD/peajes-cargos).
- Sunday 10 May 2026: spot slightly negative from about 11 to 17 h (lowest −0.82 €/MWh), 87-91 €/MWh at 21-22 h; PVPC about 52-55 €/MWh at midday (P3 all day).
- Wednesday 15 July 2026: spot 91-98 €/MWh at midday and 192 €/MWh at 21 h; summer gas demand kept midday prices well above zero.

### spain-market/negative-prices
The Spanish day-ahead market recorded its first negative hourly prices in April 2024 [35]. Negative or zero prices happen when renewable output exceeds demand plus export capacity, mostly sunny, windy spring weekends at midday [34][35].

What it means for a household: on a fixed-price "períodes" contract, nothing changes directly; prices per period stay as contracted [26]. On indexed contracts, the energy component can be near zero, but tolls, charges, adjustment services and taxes are still paid [13][14][33]. For surplus, Som's fixed tariff pays a fixed compensation price, while indexed contracts compensate at the hourly OMIE price, which can be zero or negative at those hours [39].

---

## self-consumption-compensation

How exported solar is credited, capped and turned into Sols.

### self-consumption-compensation/modalities
RD 244/2019 (as consolidated on 2026-03-21, in force as of 2026-11-20) classifies self-consumption [37]:
- Without surplus: an anti-export device prevents any export.
- With surplus, under compensation: export is credited on the bill.
- With surplus, not under compensation: surplus is sold on the market as a producer.

Simplified compensation requires all of: renewable source, total plant power up to 100 kW, a compensation contract between consumer and producer, and no specific/additional remuneration for the plant [37]. Collective self-consumption also exists; RDL 7/2026 extended the allowed distance for collective/nearby self-consumption to 5 km [45] [secondary source].

The modality of a contract is printed on its bills and contract conditions; this guide does not know it.

### self-consumption-compensation/how-it-works
Step by step, under the rules in force as of 2026-11-20 [37][38]:
1. Each hour, export and import are netted (hourly net balance). Example: if you exported 1.2 kWh and imported 0.3 kWh in the same hour, 0.9 kWh counts as surplus and 0 as import.
2. At billing, surplus kWh × the supplier's compensation price gives a credit in euros.
3. The credit is subtracted from the energy term (energy used × price).

The legal cap: "In no case may the economic value of the hourly surplus energy exceed the economic value of the hourly energy consumed from the grid in the billing period, which may not be longer than one month" [37]. So the energy term can reach 0 € but never go negative, and the compensation is monthly and does not carry over by law [37][38].

On a free-market contract, surplus is valued at the price agreed with the supplier. On PVPC, it is valued at the hourly average market price minus deviation costs [37].

### self-consumption-compensation/the-cap
What the cap limits (rule as of 2026-11-20): compensation can only reduce the energy term. It cannot reduce the power term, bono social financing, meter rental or the taxes on them [38][40]. Surplus value above the cap is lost under the law; the energy goes to the supplier, which does not have to buy it on the market [40].

On Som bills, uncompensated surplus appears as a positive line "Ajust límit de compensació per autoconsum" that brings the energy term back to zero [40].

Note: Som bills adjustment services as a separate line, apart from the energy term [26]. Example: a bill with 0.70 € of compensation and a 25.00 € energy term is far from the cap, so all the surplus is compensated. Whether Som counts adjustment services inside the cap is [unverified]; check a summer bill where the cap applies.

### self-consumption-compensation/flux-solar-sols
Flux Solar is Som Energia's own scheme for contracts with simplified compensation, launched November 2023; the conditions below are as of 2026-11-20 [40][41]. It turns surplus that the legal cap left uncompensated into Sols:
- 1 € of uncompensated surplus = 0.8 Sols; the other 20% funds the scheme and energy-transition projects [40].
- Sols appear in the Oficina Virtual the day after the bill is issued (Contractes > Autoconsum > Flux Solar) [40].
- 1 Sol = 1 € discount, applied automatically from the next bill of the same contract [40].
- Unlike compensation, Sols discount the whole bill after taxes: energy, power, bono social, meter rental, VAT and electricity tax, so a bill can reach 0 € [40]. Not the voluntary donation [40].
- A bill cannot go negative; leftover Sols wait for later bills [40].
- Sols expire 5 calendar years after the bill that created them; they are lost if the contract leaves Som or changes holder [40].
- Sols cannot be moved between contracts (a one-off transfer was offered in 2024 to contracts with over 200 Sols) [41].

Example: a month with 20 kWh of surplus at 0.0300 €/kWh is worth 0.60 €; if the energy term is larger than that, all of it is compensated and no Sols are generated.

CNMC has questioned whether "virtual battery" products comply with the literal wording of RD 244/2019 and suggested limiting monetisation to the billing period of the energy [44]. That was a CNMC report on a draft regulation; its outcome is [unverified]. Flux Solar remains in Som's current conditions [40].

### self-consumption-compensation/surplus-prices
- Som "períodes": fixed compensation price, 0.0300 €/kWh from 1 Oct 2026 [26]. Som sets it to what the energy would cost it on the wholesale market during solar hours, with no margin [39].
- Som indexed: hourly OMIE price [39].
- PVPC: hourly market price minus deviation costs [37].

Compare with import (Som prices from 1 Oct 2026): a kWh bought in P1 costs 0.249 €/kWh plus about 0.025 €/kWh adjustment services, before 5.11% tax and 21% VAT [26]. A self-consumed kWh saves roughly 6 to 9 times what an exported kWh earns at these prices [26]. That ratio is the core of most advice (see advice-patterns).

### self-consumption-compensation/summer-bills
Why a summer bill is not zero:
1. The power term is paid every day regardless of use. Example: at Som prices from 1 Oct 2026, 3.45 kW in both power periods costs 3.45 × (29.934 + 2.955) ÷ 12 = about 9.46 € a month before taxes [26].
2. Bono social financing (0.024688 €/day since 1 July 2026, about 0.75 € a month) and meter rental (0.81 € a month for a single-phase smart meter, more for three-phase) are fixed [26][29][30].
3. Compensation can only cancel the energy term, not the items above or their taxes [37][38].
4. Electricity tax and VAT apply to the fixed items (see spain-tariff-2.0TD/bill-structure).
5. Night consumption is still bought from the grid if the battery runs out.
6. Surplus above the cap is lost by law; at Som it becomes Sols worth 80% of its value on later bills [40].

Example: with 3.45 kW contracted, the fixed items above come to about 11 € a month before taxes and about 14 € with 5.11% electricity tax and 21% VAT, even with zero energy cost [estimate], unless Sols cover it.

---

## advice-patterns

Advice on use, power, battery settings, payback, offers, safety.

### advice-patterns/shift-consumption
Advice: run flexible loads (washing machine, dishwasher, water heater, EV charging) when the panels are producing; if that's impossible, in P3 (nights 0-8 h and weekends) [12][38].

Why: a kWh used directly from the panels avoids the full import price (Som prices from 1 Oct 2026: P1 0.249 €/kWh + adjustment services + taxes), while a kWh exported earns 0.03 €/kWh [26]. Som itself says the more you use in generation hours, the more you save [38]. Hourly netting means using the energy within the same hour it is exported still counts [38].

Caveats:
- With a battery in self-consumption mode, daytime surplus first fills the battery, so shifting helps most on days when the battery fills before midday.
- Watch contracted power: several big loads at once can trip the meter (see spain-tariff-2.0TD/power-control).
- Don't recommend running appliances unattended at night if the user is uneasy about it; that is their call.

### advice-patterns/size-contracted-power
Method [16][42]:
1. Get monthly maximum demand for the last 12 months from the distributor portal or Datadis (datadis.es) [16].
2. Look at the typical monthly peaks, not only the single highest one; one exceptional day should not set the contract [16].
3. With PV and a battery, the peaks that matter are those when there is no sun and the battery is empty or limited; the battery helps lower the needed power [42].
4. Reduce P1 only; keep P2 [16].
5. Check the 12-month rule and the one-off cost before suggesting a change (see spain-tariff-2.0TD/change-power).

Example: contracted 3.45 kW, highest 15-minute demand in the last year 3.9 kW in P1, and no reported cut-offs. That fits the tolerance Som describes (as of 2026-11-20) [16]. Raising power is not obviously needed. Lowering would risk cut-offs and should be judged on the monthly peaks.

Grid charging uses contracted power: in TOU mode, grid charging plus house load must stay under the contracted power, so cap "Maximum charge power of grid" accordingly [4].

### advice-patterns/battery-settings
Trade-offs to explain, not decide for the user:
- End-of-discharge SOC low (e.g. 5%): more daily saving; less reserve [6].
- Backup SOC higher: only useful if a backup box exists; it takes energy away from daily use [5].
- TOU grid charging: only worth it when the price gap pays for losses and wear. Example at Som prices from 1 Oct 2026: charging 1 kWh in P3 at 0.150 €/kWh and using it in P1 at 0.249 €/kWh saves at most about 0.10 €/kWh before losses [26]; with an assumed 90% round-trip efficiency [unverified] it is about 0.07-0.08 €. The gain is limited by how much the house actually uses in P1/P2 hours, not by battery size: a house that shifts about 3 kWh a day this way saves roughly 6-7 € a month before taxes [estimate]. In sunny months it is pointless or harmful: grid-charged energy displaces free solar that would then be exported at 0.03 €/kWh.
- Confirm grid charging is permitted for the installation before enabling it [4] [unverified legality].
- Changes should be made or approved by the installer; a wrong grid-code or export setting can break rules.

### advice-patterns/payback
How to estimate whether more panels or battery pays back (no product advice; Som and Flux Solar conditions as of 2026-11-20):
1. Annual saving = (extra self-consumed kWh × full import price incl. taxes) + (extra exported kWh × compensation price, only up to the cap) + (value of extra Sols at 0.8 €/€) [26][40].
2. Use PVGIS for extra panel production by orientation [1]; use the plant's own hourly data for how much would really be self-consumed.
3. A battery only saves on energy that would otherwise be exported, then used at night: kWh shifted per year × (import price − compensation price) [26]. Account for round-trip losses [unverified efficiency].
4. Simple payback = installed cost ÷ annual saving. Discount for degradation (about 0.5%/year for panels [2]) and battery ageing [7].
5. Som notes batteries can double the cost of a home system and last roughly 10-15 years [43]; extra panels beyond the cap mainly generate Sols at 80% value [40].
6. Caveat: future prices are unknown; give a range, not a promise.

### advice-patterns/compare-offers
- Use the CNMC price comparator (comparador.cnmc.gob.es), which lists current free-market offers [46].
- Compare with the household's real profile: kWh per period, contracted power and surplus. A cheap P1 price is worth little if most use is in P3.
- For self-consumers, compare compensation price, whether surplus above the cap is valued (e.g. Flux Solar) and any expiry of credits [40].
- Check extras billed separately (adjustment services at Som) [26].
- PVPC only if contracted power is up to 10 kW; it is the only route to the bono social (as of 2026-11-20) [27][31].
- Note Sols are lost on leaving Som [40].

### advice-patterns/safety
- Never open the inverter, battery, meter or fuse box beyond the main breaker. These carry dangerous DC voltage even when the grid is off.
- Alarms marked "installer" in huawei-fusionsolar/alarms: call the installer. Huawei's reference targets trained engineers [8].
- Don't switch the inverter's AC breaker back on after a "Grid Failure" without checks; Huawei says to verify impedance first [8].
- A power cut stops the system unless a backup box is fitted [11][5].
- Burning smell, smoke, water near equipment: switch off the main breaker if safe, leave, and call emergency services (112) and the installer.

---

## glossary

Terms in Catalan, Spanish and English, defined plainly.

### glossary/self-consumption

| Català | Español | English | Plain definition |
|---|---|---|---|
| autoconsum | autoconsumo | self-consumption | Using your own solar energy in the house [37] |
| autoproducció | autoproducción | self-generation | Som's word for producing your own electricity [38] |
| autosuficiència | autosuficiencia | self-sufficiency | Share of the house's use covered by own solar [4] |
| excedents | excedentes | surplus / export | Solar energy sent to the grid because the house didn't use it [38] |
| compensació simplificada | compensación simplificada | simplified net billing | Surplus credited on the bill, capped at the energy term [37] |
| balanç net horari | balance neto horario | hourly netting | Export and import in the same hour cancel out [38] |
| ajust límit de compensació | ajuste límite de compensación | compensation cap adjustment | Bill line removing surplus credit above the cap [40] |
| Flux Solar | Flux Solar | Flux Solar | Som scheme turning capped-off surplus into Sols [40] |
| Sols | Sols | Sols | A supplier's solar credit; 1 Sol = 1 € off a later bill [40] |

### glossary/tariff

| Català | Español | English | Plain definition |
|---|---|---|---|
| potència contractada | potencia contratada | contracted power | Max kW you can draw at once; paid per day [16] |
| terme de potència | término de potencia | power term | Fixed part of the bill: kW × price × days [12] |
| terme d'energia | término de energía | energy term | Variable part: kWh used × price [12] |
| peatges | peajes | network tolls | Regulated cost of the wires, set by CNMC [12] |
| càrrecs | cargos | system charges | Regulated system costs, set by the Ministry [12] |
| punta (P1) | punta (P1) | peak | Weekdays 10-14 h and 18-22 h, most expensive [12] |
| pla (P2) | llano (P2) | mid-peak | Weekdays 8-10, 14-18, 22-24 h [12] |
| vall (P3) | valle (P3) | off-peak | 0-8 h and all weekend/national holidays [12] |
| 2.0TD | 2.0TD | 2.0TD access tariff | Network tariff for homes up to 15 kW [12] |
| maxímetre | maxímetro | maximum-demand meter | Records peak demand; can bill excesses [16] |
| ICP | ICP | power control switch | Cuts supply if you exceed contracted power [18] |
| comptador de telegestió | contador telegestionado | smart meter | Remote-read meter with built-in ICP [18] |
| distribuïdora | distribuidora | distribution company | Owns the wires and meter; set by where you live [17] |
| comercialitzadora | comercializadora | supplier | Who sells you electricity, e.g. Som Energia [26] |

### glossary/market-and-taxes

| Català | Español | English | Plain definition |
|---|---|---|---|
| PVPC | PVPC | regulated tariff | Hourly price from reference suppliers, up to 10 kW [31] |
| mercat lliure | mercado libre | free market | Any supplier's own price offer [31] |
| preu indexat | precio indexado | indexed price | Follows the wholesale market hour by hour [39] |
| mercat majorista / pool | mercado mayorista | wholesale market | Where electricity is traded day-ahead (OMIE) [36] |
| OMIE | OMIE | Iberian market operator | Runs the day-ahead market [36] |
| REE | REE | grid operator | Runs the grid; publishes prices [34] |
| serveis d'ajust | servicios de ajuste | adjustment services | Cost of balancing the grid; some suppliers bill it apart [26] |
| bo social | bono social | social discount | PVPC discount for vulnerable homes [27] |
| finançament del bo social | financiación del bono social | social bonus levy | Fixed daily charge every bill pays [26] |
| impost elèctric | impuesto eléctrico (IEE) | electricity tax | 5.11% tax on the electricity bill [20] |
| IVA | IVA | VAT | 21% (10% at times in 2026) [22][23] |
| lloguer del comptador | alquiler del contador | meter rental | Daily fee for the meter [30] |
| drets d'accés / extensió | derechos de acceso / extensión | access / extension rights | One-off fees when raising power [19] |
| butlletí elèctric | boletín eléctrico | installation certificate | Electrician's certificate of the wiring [17] |
| Datadis | Datadis | Datadis | Portal with your hourly meter data [16] |
| CUPS | CUPS | supply point code | Unique ID of your connection, printed on the bill |

### glossary/equipment

| Català | Español | English | Plain definition |
|---|---|---|---|
| kWp | kWp | kilowatt-peak | Panel rating under test conditions |
| kW | kW | kilowatt | Power at a moment (speed) [16] |
| kWh | kWh | kilowatt-hour | Energy over time (distance) [12] |
| producció / rendiment | producción / rendimiento | yield | Energy the system produced [10] |
| injecció a xarxa | vertido a red | feed-in | Energy exported to the grid [10] |
| inversor | inversor | inverter | Turns panel DC into household AC [9] |
| inversor híbrid | inversor híbrido | hybrid inverter | Inverter that also manages a battery [4] |
| bateria | batería | battery (ESS) | Stores surplus for later [7] |
| SOC (estat de càrrega) | SOC (estado de carga) | state of charge | Battery fill level in % [4] |
| SOC de fi de descàrrega | SOC fin de descarga | end-of-discharge SOC | Battery floor in normal use [4] |
| SOC de reserva | SOC de respaldo | backup SOC | Reserve kept for power cuts [5] |
| càrrega des de xarxa | carga desde red | grid charging | Charging the battery from the grid [4] |
| mode TOU | modo TOU | time-of-use mode | Battery charges/discharges at set hours [4] |
| autoconsum màxim | máximo autoconsumo | max self-consumption | Battery mode prioritising own use [4] |
| caixa de backup | caja de backup | backup box | Lets the house run on battery in a power cut [5] |
| sensor de potència | sensor de potencia | smart power sensor | Huawei meter at the grid connection [10] |
| retall (clipping) | recorte | clipping | Inverter capping output at its limit [3] |
| degradació | degradación | degradation | Slow yearly loss of panel output, ~0.5% [2] |
| PVGIS | PVGIS | PVGIS | EU tool estimating solar production [1] |

---

## Sources

All accessed 2026-11-20.

1. European Commission JRC, PVGIS API v5.3 PVcalc, lat 41.39, lon 2.17 (Barcelona), 1 kWp, loss 14%, angle 30°, aspect 0/−90/90, SARAH3 2005-2023. https://re.jrc.ec.europa.eu/api/v5_3/PVcalc?lat=41.39&lon=2.17&peakpower=1&loss=14&angle=30&aspect=0&outputformat=json
2. Jordan, D.C., Kurtz, S.R., "Photovoltaic Degradation Rates: An Analytical Review", NREL/JA-5200-51664. https://docs.nlr.gov/docs/fy12osti/51664.pdf (abstract: https://www.osti.gov/biblio/1045052)
3. EPRI, "Renewables Insights: The Impact of Solar PV DC:AC Ratio" (snippet only). https://restservice.epri.com/publicdownload/000000003002014245/0/Product
4. Huawei, FusionSolar App and SUN2000 App Device Commissioning Guide, "Power Adjustment" (EDOC1100273864). https://support.huawei.cn/enterprise/en/doc/EDOC1100273864/3c56e50e/power-adjustment
5. Huawei, LUNA2000-(5-30)-S0 User Manual, "Setting the Mode for the Grid-tied and Off-grid ESS" (EDOC1100167258). https://support.huawei.com/enterprise/en/doc/EDOC1100167258/e85f8ed5/setting-the-mode-for-the-grid-tied-and-off-grid-ess
6. Huawei, LUNA2000-(5-30)-S0 User Manual V17 (2024-05-30), distributor copy. https://ske-solar.com/productdata/LUNA2000-S0/02_Manuals/UserManual_LUNA2000-%285-30%29-S0_V17_2024-05-30_EN.pdf
7. Huawei, LUNA2000-5/10/15-S0 datasheet. https://solar.huawei.com/dam/asset/view/cc3f55c9603845749334087ea716cc23.pdf
8. Huawei, Inverter Alarm Reference, Issue 09 (2024-11-01), distributor copy. https://nrr.lt/storage/18680/Alarm-Explanations-EN.pdf
9. Huawei, SUN2000-(3KTL-10KTL)-M1 User Manual V17 (2024-01-12), distributor copy. https://ske-solar.com/productdata/SUN2000-M1/02_Manuals/User%20Manual_SUN2000-(3KTL-10KTL)-M1_V17_2024-01-12_EN.pdf
10. Huawei, SmartLogger3000 User Manual V20 (2024-04-15), distributor copy. https://ske-solar.com/productdata/SmartLogger/02_Manuals/UserManual_SmartLogger3000_V20_2024-04-15_EN.pdf
11. Som Energia Help Centre, "Autoproducció: què passa si marxa la llum?". https://ca.support.somenergia.coop/article/929-autoproduccio-que-passa-si-marxa-la-llum
12. Consumo Responde (Junta de Andalucía), "La estructura de peajes de transporte y distribución y cargos del sistema eléctrico" (updated 2025-12-31). https://www.consumoresponde.es/art%C3%ADculos/la_estructura_de_peajes_de_transporte_y_distribucion_y_cargos_del_sistema_electrico
13. BOE-A-2025-26348, CNMC Resolution of 18 Dec 2025, tolls from 1 Jan 2026. https://www.boe.es/diario_boe/txt.php?id=BOE-A-2025-26348
14. BOE-A-2025-26705, Orden TED/1524/2025, charges for 2026. https://www.boe.es/diario_boe/txt.php?id=BOE-A-2025-26705
15. MITECO, "Peajes de acceso ... y cargos". https://www.miteco.gob.es/en/energia/energia-electrica/electricidad/peajes.html
16. Som Energia Help Centre, "Com puc saber la potència que necessito?". https://ca.support.somenergia.coop/article/269-com-puc-saber-la-potencia-que-necessito
17. Som Energia Help Centre, "Modificació de la potència contractada" (updated 2025-04-14). https://ca.support.somenergia.coop/article/271-com-puc-fer-una-modificacio-de-potencia-o-de-tarifa-i-quant-costa
18. Som Energia Help Centre, "L'interruptor de control de potència o ICP". https://ca.support.somenergia.coop/article/172-l-interruptor-de-control-de-potencia-o-icp
19. CNMC, "¿Cómo cambiar las condiciones del contrato?" (PDF). https://www.cnmc.es/sites/default/files/editor_contenidos/Energia/Consumidores/5.%20C%C3%B3mo%20modificar%20las%20condiciones%20del%20contrato.pdf
20. BOE-A-2026-6544, Real Decreto-ley 7/2026, de 20 de marzo. https://www.boe.es/buscar/doc.php?id=BOE-A-2026-6544
21. Agencia Tributaria, "Medidas tributarias ... Oriente Medio: Impuesto Especial sobre la Electricidad" (monthly table). https://sede.agenciatributaria.gob.es/Sede/impuestos-especiales-medioambientales/impuesto-especial-sobre-electricidad/medidas-tributarias-combatir-crisis-energetica-electricidad.html
22. Agencia Tributaria, "Medidas tributarias del Real Decreto-ley 18/2026" (30 Jun 2026). https://sede.agenciatributaria.gob.es/Sede/todas-noticias/2026/junio/30/medidas-tributarias-real-decreto-ley-182026.html
23. Agencia Tributaria, IVA novedades 2026, Real Decreto-ley 25/2026. https://sede.agenciatributaria.gob.es/Sede/iva/novedades-iva/novedades-normativa-2026/medidas-tributarias-real-decreto-ley-2026_.html
24. BOE-A-2026-20265, Real Decreto-ley 25/2026, de 29 de septiembre. https://www.boe.es/buscar/act.php?id=BOE-A-2026-20265
25. Agencia Tributaria, IVA novedades 2026, Real Decreto-ley 10/2026. https://sede.agenciatributaria.gob.es/Sede/iva/novedades-iva/novedades-normativa-2026/real-decreto-ley-10-2026-abril.html
26. Som Energia, "Tarifa de la llum per períodes horaris" (prices valid from 1 Oct 2026). https://www.somenergia.coop/ca/tarifes-llum/domestic-periodes
27. CNMC, "Bono social eléctrico". https://www.cnmc.es/facil-para-ti/que-hace-la-cnmc-para-consumidores/bono-social-electrico
28. MITECO, "¿Cuáles son los requisitos para solicitarlo?" (bono social). https://www.miteco.gob.es/es/energia/pobreza-energetica/pe-001/requisitos.html
29. OCU, "Bono social: suben los importes para financiarlo" (secondary; 2026). https://www.ocu.org/vivienda-y-energia/gas-luz/noticias/financiacion-bono-social-2026
30. BOE-A-2007-22458, Orden ITC/3860/2007 (consolidated). https://www.boe.es/buscar/act.php?id=BOE-A-2007-22458
31. MITECO, "Precio Voluntario para el Pequeño Consumidor (PVPC)". https://www.miteco.gob.es/es/energia/energia-electrica/electricidad/contratacion-suministro/precio-voluntario.html
32. MITECO press release, 13 Jun 2023, new PVPC methodology. https://www.miteco.gob.es/es/prensa/ultimas-noticias/2023/06/_el_gobierno_apruebalanuevametodologiadecalculodelatarifaregulad.html
33. REE ESIOS, PVPC page. https://www.esios.ree.es/es/pvpc
34. REE apidatos, "precios-mercados-tiempo-real" (queried for 2026-05-10, 2026-07-15, 2026-11-19). https://apidatos.ree.es/es/datos/mercados/precios-mercados-tiempo-real
35. REE, Informe del Sistema Eléctrico 2024, Mercado diario. https://www.sistemaelectrico-ree.es/es/2024/informe-del-sistema-electrico/mercados/mercado-diario
36. OMIE, press release 1 Oct 2025, go-live of 15-minute products in the day-ahead market. https://www.omie.es/sites/default/files/2025-10/2501001_go_live_mtu15_md_es_vf.pdf
37. BOE-A-2019-5089, Real Decreto 244/2019 (consolidated, version 2026-03-21). https://www.boe.es/buscar/act.php?id=BOE-A-2019-5089
38. Som Energia Help Centre, "Com funciona la compensació simplificada d'excedents?". https://ca.support.somenergia.coop/article/783-com-funciona-la-compensacio-simplificada-dexcedents
39. Som Energia Help Centre, "Preu de compensació dels excedents en autoproducció" (updated 2025-07-16). https://ca.support.somenergia.coop/article/799-preu-compensacio-excedents-autoproduccio
40. Som Energia Help Centre, "Què és i com funciona el Flux Solar?" (updated 2025-07-28). https://ca.support.somenergia.coop/article/1371-que-es-el-flux-solar
41. Som Energia, "El Flux Solar no permetrà l'intercanvi de Sols entre contractes". https://www.somenergia.coop/ca/actualitat/cooperativa/el-flux-solar-no-permetra-lintercanvi-de-sols-entre-contractes
42. Som Energia Help Centre, "Puc reduir la potència contractada si disposo d'un sistema d'autoproducció?". https://ca.support.somenergia.coop/article/971-puc-reduir-la-potencia-contractada-si-disposo-dun-sistema-dautoproduccio
43. Som Energia Help Centre, "Em convé instal·lar bateries...?". https://ca.support.somenergia.coop/article/967-em-conve-instal-lar-bateries-o-sistemes-dacumulacio-en-una-instal-lacio-d-autoproduccio
44. CNMC, report on the draft Royal Decree amending RD 244/2019 (PDF). https://www.cnmc.es/sites/default/files/6550837.pdf
45. EY, "Real Decreto-ley 7/2026: Medidas en relación con renovables y almacenamiento" (secondary). https://www.ey.com/content/dam/ey-unified-site/ey-com/es-es/technical/alertas-fiscal-legal/ey-26-03-23-alerta-rdl-7-2026-renovables-almacenamiento-.pdf
46. CNMC electricity offer comparator. https://comparador.cnmc.gob.es
48. BOE-A-2020-1066, CNMC Circular 3/2020 (tolls methodology and periods, consolidated). https://www.boe.es/buscar/act.php?id=BOE-A-2020-1066
