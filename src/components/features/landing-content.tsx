'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

export function LandingContent() {
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  useEffect(() => {
    // Enhanced header scroll effect
    let lastScrollTop = 0;
    const handleScroll = () => {
      const header = document.querySelector('header');
      if (!header) return;
      
      const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
      
      if (scrollTop > 100) {
        header.style.background = 'rgba(0, 103, 105, 0.98)';
        header.style.backdropFilter = 'blur(20px)';
        header.style.boxShadow = '0 10px 40px rgba(0, 103, 105, 0.2)';
      } else {
        header.style.background = 'rgba(0, 103, 105, 0.95)';
        header.style.backdropFilter = 'blur(20px)';
        header.style.boxShadow = '0 2px 10px rgba(0, 103, 105, 0.1)';
      }
      
      // Hide/show header on scroll
      if (scrollTop > lastScrollTop && scrollTop > 200) {
        header.style.transform = 'translateY(-100%)';
      } else {
        header.style.transform = 'translateY(0)';
      }
      lastScrollTop = scrollTop;
    };

    window.addEventListener('scroll', handleScroll);

    // Advanced scroll animations
    const observerOptions = {
      threshold: 0.1,
      rootMargin: '0px 0px -50px 0px'
    };

    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry, index) => {
        if (entry.isIntersecting) {
          const timeoutId = window.setTimeout(() => {
            entry.target.classList.add('visible');
          }, index * 100); // Stagger animations
          
          return () => window.clearTimeout(timeoutId);
        }
      });
    }, observerOptions);

    // Observe all animated elements
    const animatedElements = document.querySelectorAll('.fade-in, .slide-in-left, .slide-in-right');
    animatedElements.forEach(el => {
      observer.observe(el);
    });

    // Parallax effect for hero section
    const handleParallax = () => {
      const scrolled = window.pageYOffset;
      const hero = document.querySelector('.hero') as HTMLElement;
      const heroCard = document.querySelector('.hero-card') as HTMLElement;
      
      if (hero && heroCard) {
        hero.style.transform = `translateY(${scrolled * 0.5}px)`;
        heroCard.style.transform = `rotate(-5deg) translateY(${-scrolled * 0.3}px)`;
      }
    };

    window.addEventListener('scroll', handleParallax);

    // Add loading animation
    const bodyEl = document.body;
    const originalOpacity = bodyEl.style.opacity;
    const originalTransition = bodyEl.style.transition;
    
    bodyEl.style.opacity = '0';
    bodyEl.style.transition = 'opacity 0.5s ease';
    
    const loadingTimeoutId = window.setTimeout(() => {
      bodyEl.style.opacity = '1';
    }, 100);

    return () => {
      window.removeEventListener('scroll', handleScroll);
      window.removeEventListener('scroll', handleParallax);
      window.clearTimeout(loadingTimeoutId);
      observer.disconnect();
      
      // Restore original body styles
      bodyEl.style.opacity = originalOpacity;
      bodyEl.style.transition = originalTransition;
    };
  }, []);

  const toggleMenu = () => {
    setIsMenuOpen(!isMenuOpen);
  };

  const handleLinkClick = (e: React.MouseEvent<HTMLAnchorElement>, targetId: string) => {
    e.preventDefault();
    setIsMenuOpen(false);
    const target = document.querySelector(targetId);
    if (target) {
      const headerHeight = document.querySelector('header')?.offsetHeight || 0;
      const targetPosition = (target as HTMLElement).offsetTop - headerHeight;
      
      window.scrollTo({
        top: targetPosition,
        behavior: 'smooth'
      });
    }
  };

  return (
    <>
      {/* Premium Header */}
      <header>
        <nav>
          <div className="logo">hanh94esl</div>
          <ul className={`nav-links ${isMenuOpen ? 'active' : ''}`}>
            <li><a href="#home" onClick={(e) => handleLinkClick(e, '#home')}>Home</a></li>
            <li><a href="#features" onClick={(e) => handleLinkClick(e, '#features')}>Features</a></li>
            <li><a href="#testimonials" onClick={(e) => handleLinkClick(e, '#testimonials')}>Reviews</a></li>
            <li><a href="#contact" onClick={(e) => handleLinkClick(e, '#contact')}>Contact</a></li>
          </ul>
          <button className="mobile-menu" onClick={toggleMenu}>
            <i className={`fas ${isMenuOpen ? 'fa-times' : 'fa-bars'}`}></i>
          </button>
        </nav>
      </header>

      {/* Luxurious Hero Section */}
      <section className="hero" id="home">
        <div className="hero-content">
          <div className="hero-text">
            <h1>Elevate Your IELTS Journey</h1>
            <p className="subtitle">Experience the future of IELTS preparation with our premium platform. Designed for excellence, built for success, trusted by educators worldwide.</p>
            <div className="cta-buttons">
              <Link href="/login" className="cta-primary">
                <i className="fab fa-google"></i>
                Sign in with Google
              </Link>
              <a href="#features" className="cta-secondary" onClick={(e) => handleLinkClick(e, '#features')}>
                <i className="fas fa-play"></i>
                Watch Demo
              </a>
            </div>
          </div>
          <div className="hero-visual">
            <div className="hero-card">
              <div className="icon">
                <i className="fas fa-graduation-cap text-white"></i>
              </div>
              <h3>Premium IELTS Platform</h3>
              <p>AI-Powered • Secure • Professional</p>
            </div>
          </div>
        </div>
      </section>

      {/* Main Content */}
      <main>
        {/* Elegant User Types Section */}
        <section className="section user-types">
          <div className="container">
            <div className="section-header">
              <h2 className="section-title fade-in">Crafted for Excellence</h2>
              <p className="section-subtitle fade-in">Whether you&apos;re an educator shaping minds or a student pursuing dreams, our platform provides the sophisticated tools you deserve.</p>
            </div>
            
            <div className="user-cards">
              <div className="user-card slide-in-left">
                <div className="icon">
                  <i className="fas fa-chalkboard-teacher"></i>
                </div>
                <h3>For Educators</h3>
                <p>Empower your teaching with our comprehensive suite of tools. Create sophisticated IELTS assessments, monitor student progress with precision, and deliver personalized feedback through our advanced AI-assisted grading system. Transform your classroom into a center of excellence.</p>
              </div>
              
              <div className="user-card slide-in-right">
                <div className="icon">
                  <i className="fas fa-user-graduate"></i>
                </div>
                <h3>For Achievers</h3>
                <p>Unlock your potential with personalized IELTS preparation that adapts to your unique learning style. Access premium practice tests, receive detailed performance insights, and track your journey to success with our intelligent analytics platform.</p>
              </div>
            </div>
          </div>
        </section>

        {/* Premium Features Section */}
        <section className="section features" id="features">
          <div className="container">
            <div className="section-header">
              <h2 className="section-title fade-in">Sophisticated Features</h2>
              <p className="section-subtitle fade-in">Every feature meticulously designed to deliver an unparalleled IELTS preparation experience.</p>
            </div>
            
            <div className="features-grid">
              <div className="feature-card fade-in">
                <div className="icon">
                  <i className="fas fa-file-signature"></i>
                </div>
                <h4>Intelligent Test Creation</h4>
                <p>Design comprehensive IELTS assessments with our intuitive builder. Support for all four skills with advanced question types and customizable difficulty levels.</p>
              </div>
              
              <div className="feature-card fade-in">
                <div className="icon">
                  <i className="fas fa-brain"></i>
                </div>
                <h4>AI-Powered Assessment</h4>
                <p>Revolutionary artificial intelligence provides accurate, consistent grading for writing and speaking tasks, delivering detailed feedback in seconds.</p>
              </div>
              
              <div className="feature-card fade-in">
                <div className="icon">
                  <i className="fas fa-shield-virus"></i>
                </div>
                <h4>Advanced Security</h4>
                <p>Military-grade anti-cheating technology ensures test integrity with real-time monitoring, behavior analysis, and comprehensive security protocols.</p>
              </div>
              
              <div className="feature-card fade-in">
                <div className="icon">
                  <i className="fas fa-chart-line"></i>
                </div>
                <h4>Premium Analytics</h4>
                <p>Gain deep insights with sophisticated performance analytics, predictive modeling, and personalized improvement recommendations.</p>
              </div>
              
              <div className="feature-card fade-in">
                <div className="icon">
                  <i className="fas fa-bolt"></i>
                </div>
                <h4>Instant Intelligence</h4>
                <p>Receive immediate, actionable feedback with detailed explanations, improvement strategies, and personalized learning paths.</p>
              </div>
              
              <div className="feature-card fade-in">
                <div className="icon">
                  <i className="fas fa-mobile-alt"></i>
                </div>
                <h4>Seamless Experience</h4>
                <p>Enjoy flawless performance across all devices with our responsive design that maintains premium quality on any screen size.</p>
              </div>
            </div>
          </div>
        </section>

        {/* Testimonials Section */}
        <section className="section testimonials" id="testimonials">
          <div className="container">
            <div className="section-header">
              <h2 className="section-title fade-in">Voices of Success</h2>
              <p className="section-subtitle fade-in">Join thousands of educators and students who have transformed their IELTS experience with our premium platform.</p>
            </div>
            
            <div className="testimonial-grid">
              <div className="testimonial-card fade-in">
                <div className="quote">
                  hanh94esl has revolutionized my teaching methodology. The AI grading system is remarkably accurate, and the analytics provide insights I never had before. My students&apos; success rates have increased by 40%.
                </div>
                <div className="author">
                  <div className="avatar">SM</div>
                  <div className="author-info">
                    <h5>Dr. Sarah Mitchell</h5>
                    <p>Senior IELTS Instructor, Cambridge Academy</p>
                  </div>
                </div>
              </div>
              
              <div className="testimonial-card fade-in">
                <div className="quote">
                  The personalized feedback and adaptive learning system helped me achieve my target score of 8.5. The platform&apos;s sophistication and attention to detail are unmatched in the industry.
                </div>
                <div className="author">
                  <div className="avatar">LA</div>
                  <div className="author-info">
                    <h5>Lan Anh Vu</h5>
                    <p>Student of FPT University</p>
                  </div>
                </div>
              </div>
              
              <div className="testimonial-card fade-in">
                <div className="quote">
                  As an institution director, I&apos;m impressed by the platform&apos;s comprehensive security features and detailed reporting. It has elevated our IELTS program to international standards.
                </div>
                <div className="author">
                  <div className="avatar">MR</div>
                  <div className="author-info">
                    <h5>Maria Rodriguez</h5>
                    <p>Director, Global Excellence Institute</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* Premium Footer */}
      <footer id="contact">
        <div className="container">
          <div className="footer-content">
            <div className="footer-section brand">
              <h4>hanh94esl</h4>
              <p>Pioneering the future of IELTS preparation through innovative technology, sophisticated design, and unwavering commitment to educational excellence.</p>
              <div className="social-icons">
                <a href="https://www.facebook.com/vu.lan.anh.922029" aria-label="Facebook"><i className="fab fa-facebook-f"></i></a>
                <a href="#" aria-label="Twitter"><i className="fab fa-twitter"></i></a>
                <a href="#" aria-label="LinkedIn"><i className="fab fa-linkedin-in"></i></a>
                <a href="#" aria-label="Instagram"><i className="fab fa-instagram"></i></a>
              </div>
            </div>
            
            <div className="footer-section">
              <h4>Platform</h4>
              <ul>
                <li><a href="#features" onClick={(e) => handleLinkClick(e, '#features')}>Features</a></li>
                <li><a href="#pricing">Pricing</a></li>
                <li><a href="#security">Security</a></li>
                <li><a href="#integrations">Integrations</a></li>
              </ul>
            </div>
            
            <div className="footer-section">
              <h4>Support</h4>
              <ul>
                <li><a href="#help">Help Center</a></li>
                <li><a href="#">Privacy Policy</a></li>
                <li><a href="#terms">Terms of Service</a></li>
                <li><a href="#api">API Documentation</a></li>
              </ul>
            </div>
            
            <div className="footer-section">
              <h4>Connect</h4>
              <ul>
                <li><a href="mailto:support@hanh94esl.com">support@hanh94esl.com</a></li>
                <li><a href="tel:+84888686868">+84 8686 86868</a></li>
                <li><a href="#location">Ninh Binh Province</a></li>
                <li><a href="#nation">Viet Nam</a></li>
              </ul>
            </div>
          </div>
          
          <div className="footer-bottom">
            <p>&copy; 2025 hanh94esl. All rights reserved. Masterfully crafted by L.A. to inspire educational brilliance.</p>
          </div>
        </div>
      </footer>
    </>
  );
}
