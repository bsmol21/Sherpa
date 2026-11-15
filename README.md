# SHERPA

> **How to run this project?**

In the git repo download matriz_elevacion.asc onto the mvp/rutes folder, this is the altitude matrix used to display the map

Then

In the root of the project:

`py -m venv .venv`
`.venv\Scripts\python.exe -m pip install -r` 
`.venv\Scripts\python.exe mvp\Rutes\visor_rutas.py`


> **When the storm hits, who will guide you home?**

We developed **SHERPA**, a helmet-integrated guide for astronauts walking on Mars, inspired by the role of a mountain sherpa: it watches the sky and ground, tells you when to turn back, and shows the safest way back to shelter

By receiving environmental data through Mars' orbital satellite network, SHERPA monitors incoming hazards such as solar storms, dust events, and extreme temperature changes. When danger arises, it evaluates evacuation routes to nearby safe locations, including habitats, pressurized workstations, and exploration vehicles, using an algorithm that balances distance with terrain safety.

Guidance is delivered through the helmet visor and auditory alerts, providing redundant support even when communication with Earth is unavailable or inviable. Beyond survival, SHERPA helps astronauts plan scientifically valuable expeditions by identifying geological formations and soil compositions relevant to the search for signs of past or present life.

Like its mountain namesake, SHERPA does more than guide explorers toward their destination: **it helps ensure they can make it back.**

## Why SHERPA?

The Martian environment is extremely hostile and unpredictable. A dust storm can swallow the horizon, a solar particle event can turn open ground into a radiation hazard, and the nearest voice that could help is several minutes away by radio. Exploring Mars on foot means making life-or-death decisions alone. SHERPA exists so no astronaut has to make them on the blind.

## What is SHERPA?

SHERPA is a survival and navigation guide built into the astronaut’s helmet. It is named after the mountain guides who know the way and advise rather than order. Our prototype is an interactive map of a segment of the Jezero Crater delta, with a first-person helmet dashboard. Choose two points, and SHERPA plots your course. It will show you locations of scientific interest along the way, as well as details related to your environment, like soil composition or geological region.

## How SHERPA shows you the way

Forget flat maps. SHERPA renders the real terrain in **3D** and puts you in first person, following a blue line across the landscape while a sherpa astronaut walks ahead and guides you to your target.

The visor brings everything into one dashboard:

- **Navigation:** speed, distance traveled and remaining, and travel time.
- **Resources:** oxygen and water consumption.
- **Terrain:** the geological region beneath your boots.

Terrain warnings, space weather alerts, and turn directions arrive as text and as short, discreet audio cues. We kept them simple on purpose: guidance that annoys gets ignored.

## How SHERPA is modelled

Before you leave, SHERPA answers the question that matters most: **how can you get back?**

Every pixel of the map, at **10 meters per pixel**, is a node in a **Dijkstra pathfinding graph**. SHERPA finds the shortest route, never crosses slopes above **15°**, and estimates resource use from distance and slope, using an approximation from NASA studies of suited lunar walking for an **80 kg astronaut** (an average of **48.5 L of oxygen per km**).

Then it checks that the **entire round-trip fits within your oxygen capacity**.

## What SHERPA does in an emergency

Dust storms and solar particle events rarely announce themselves, so SHERPA is built to react the moment one is declared. In our prototype you can place safe bases and shelters, then trigger a dust storm or solar particle event anywhere, at any time, modeled on historical records.

SHERPA instantly:

1. Evaluates the route to every safe location.
2. Compares them and plots the safest route: the closest with the gentlest slope.
3. Recalculates the resources for the way home.

The astronaut sees the new path, hears the instruction, and moves.

Since SHERPA is multilayered (elevation, soil composition, geological regions) it can guide astronauts toward scientifically valuable terrain, not only away from danger.

## A guide that doesn’t wait for Earth

SHERPA is designed around active communication with the Mars-orbiting satellite network, and it runs locally as **deterministic software, not an AI**. Every recommendation traces back to a rule and a number.

When a spacewalk goes wrong and the link to Earth is slow or gone, the astronaut still has a guide that knows the terrain, the resources, and the way home.

We wanted SHERPA to convey experience and guidance, not command. That shaped everything: sparse alerts, transparent logic, safety margins on slope and round-trip resources, and independence from Earth.

## Built with

| Area | Technologies and tools |
| --- | --- |
| Prototype | Python, React.js, HTML, and JavaScript |
| Geospatial processing | QGIS and NASA’s Mars Trek |
| Development | VS Code |

We used NASA open science data including **Digital Terrain Models (DTM)** from the HiRise instrument aboard MRO and layered views of the terrain from NASA’s Mars Trek online tool.

