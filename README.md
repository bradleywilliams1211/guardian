# Guardian

Guardian is a web-based glucose monitoring and data visualization platform designed to simplify diabetes management. The platform provides real-time glucose tracking, intuitive data visualization, and a clean dashboard experience to help users better understand and respond to their glucose levels.

The goal of Guardian is to reduce the daily burden of managing diabetes by presenting complex glucose data in a simple, accessible, and easy-to-read format. By combining modern web technologies with a lightweight architecture, Guardian creates a fast and responsive experience that works across devices.

This project was created and developed by Bradley Williams as part of an effort to explore how technology can improve accessibility and health management tools for people living with diabetes.


--------------------------------------------------
PROJECT STATUS
--------------------------------------------------

- Status: Active Development
- Version: Early Prototype
- Platform: Web
- Maintainer: Bradley Williams

Guardian is currently under active development. Features and functionality will continue to evolve as the platform grows.


--------------------------------------------------
FEATURES
--------------------------------------------------

- Real-time glucose data visualization
- Interactive glucose charts and graphs
- Zoom and pan functionality for detailed data analysis
- Clean and responsive dashboard interface
- Lightweight single-page architecture
- Developer mode for testing and simulation
- Session-based login system
- Mobile-friendly layout
- Footer navigation with informational pages

The interface focuses on clarity and usability so users can quickly identify trends, highs, lows, and patterns in their glucose data.


--------------------------------------------------
TECHNOLOGY STACK
--------------------------------------------------

Frontend

- HTML5
- CSS3
- JavaScript

Libraries

- Chart.js (graph visualization)
- chartjs-plugin-zoom (chart zoom and pan controls)
- Three.js (optional graphical components)

Infrastructure

- Cloudflare Workers (serverless backend)
- Cloudflare KV Storage (data and session storage)


--------------------------------------------------
PROJECT STRUCTURE
--------------------------------------------------

guardian/

- worker.js
  Cloudflare Worker backend logic and routing

- html.js
  Main HTML, CSS, and JavaScript dashboard file

- wrangler.toml
  Cloudflare worker configuration

- public/
  Static assets

    - images/
        - favicon/

- README.md
  Project documentation

--------------------------------------------------
PROJECT VISION
--------------------------------------------------

Guardian was created to make diabetes management simpler, smarter, and less stressful. Managing diabetes requires constant monitoring, analysis, and decision-making throughout the day. Many people, especially children, elderly individuals, and those with disabilities, carry this responsibility every hour.

Guardian aims to reduce that burden by providing tools that make glucose data easier to understand and act on. The long-term vision is to build technology that helps people spend less time worrying about their condition and more time living their lives.


--------------------------------------------------
FUTURE DEVELOPMENT
--------------------------------------------------

Planned areas of development include:

- Continuous glucose monitor integration
- AI-assisted glucose trend analysis
- Mobile application support
- Caregiver and family sharing tools
- Smart alert notifications
- Expanded analytics dashboard


--------------------------------------------------
CONTRIBUTING
--------------------------------------------------

Guardian is currently developed and maintained internally.

External code contributions are not being accepted at this time. However, feedback, suggestions, and bug reports are always welcome and may help improve the platform.

If you would like to share feedback or report an issue, please open an issue in this repository.


--------------------------------------------------
LICENSE
--------------------------------------------------

Copyright (c) 2026 Bradley Williams

All rights reserved.

The code in this repository may not be copied, modified, distributed, or used commercially without explicit permission from the author.

--------------------------------------------------
Contact
--------------------------------------------------

Email: bradleywilliams121107@gmail.com
Text: 205-983-2410

--------------------------------------------------
AUTHOR
--------------------------------------------------

Bradley Williams  
Founder of Guardian
