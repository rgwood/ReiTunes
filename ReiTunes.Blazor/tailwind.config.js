const colors = require('tailwindcss/colors');
const defaultTheme = require('tailwindcss/defaultTheme')

module.exports = {
    content: [
        '!**/{bin,obj,node_modules}/**',
        '**/*.{razor,html}',
    ],
    theme:
    {
        extend:
        {
            colors: {
                'dotnet-blurple': '#512BD4',
                'link-blue': colors.blue[500],
                // https://ethanschoonover.com/solarized/
                solarized: {
                    base03: "#002b36",
                    base02: "#073642",
                    base01: "#586e75",
                    base00: "#657b83",
                    base0: "#839496",
                    base1: "#93a1a1",
                    base2: "#eee8d5",
                    base3: "#fdf6e3",
                    yellow: "#b58900",
                    orange: "#cb4b16",
                    red: "#dc322f",
                    magenta: "#d33682",
                    violet: "#6c71c4",
                    blue: "#268bd2",
                    cyan: "#2aa198",
                    green: "#859900"
                },
            },
            fontFamily: {
                // override the default font
                'sans': ['Inconsolata', ...defaultTheme.fontFamily.sans],
            },
        }
    },
    darkMode: 'media',
    plugins: [
        require('tailwindcss-debug-screens')
    ]
}
