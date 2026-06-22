import React from 'react';

export function ResponsiveBanner({ title, subtitle }) {
  return (
    <div className="main-banner-wrap">
      <div className="main-banner-box">
        <div className="main-banner-row">{title}</div>
        <div className="main-banner-row main-banner-sub">{subtitle}</div>
      </div>
    </div>
  );
}
