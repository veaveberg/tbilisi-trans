from PIL import Image

def generate_maskable_icons():
    # Load original 512x512 icon
    orig_path = 'public/android-chrome-512x512.png'
    print(f"Loading original icon from {orig_path}...")
    orig_img = Image.open(orig_path)
    
    # Target sizes for the output icons
    sizes = [512, 192]
    
    for size in sizes:
        # Calculate the scaled size for the logo inside the canvas (78% of total size)
        logo_size = int(size * 0.78)
        # Ensure it's an even number so it centers perfectly
        if logo_size % 2 != 0:
            logo_size += 1
            
        print(f"Generating {size}x{size} maskable icon (logo scaled to {logo_size}x{logo_size})...")
        
        # Scale the original image using high-quality resampling (LANCZOS)
        scaled_logo = orig_img.resize((logo_size, logo_size), Image.Resampling.LANCZOS)
        
        # Create a solid white background canvas
        maskable_canvas = Image.new('RGBA', (size, size), (255, 255, 255, 255))
        
        # Calculate the paste coordinates to center the scaled logo
        offset = (size - logo_size) // 2
        
        # Paste the scaled logo onto the canvas using its own alpha channel as a mask
        maskable_canvas.paste(scaled_logo, (offset, offset), scaled_logo)
        
        # Convert to RGB (or keep RGBA since PWA expects PNG, but with fully solid background)
        # Keeping RGBA is standard, but the canvas itself has alpha = 255 everywhere.
        output_path = f'public/android-chrome-maskable-{size}x{size}.png'
        maskable_canvas.save(output_path, 'PNG')
        print(f"✓ Saved to {output_path}")

if __name__ == '__main__':
    generate_maskable_icons()
