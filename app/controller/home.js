'use strict';

// 引入webdriver
const webdriver = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
// 引入chromedriver
require('chromedriver');
// 引入axios模块
const axios = require('axios');
// 引入uuid模块
const { v4 } = require('uuid');
// 引入os模块
const os = require('os');

const { Controller } = require('egg');

class HomeController extends Controller {
  async start() {
    const { ctx, config } = this;
    ctx.logger.info('开始处理');
    // 生成uuid
    const uuid = v4();
    ctx.logger.info(`生成uuid:${uuid}`);
    // 实例化selenium
    const chromeData = new chrome.Options();
    // selenium配置
    chromeData.addArguments('--no-sandbox');
    chromeData.excludeSwitches([ 'enable-logging' ]); // 不加载日志
    if (config.env === 'prod') {
      chromeData.addArguments('--headless'); // 不打开浏览器运行;
    }
    chromeData.addArguments('--disable-gpu'); // 禁用GPU
    const By = webdriver.By;
    const driver = new webdriver.Builder()
      .forBrowser('chrome')
      .setChromeOptions(chromeData)
      // .usingServer('http://192.168.1.100:4444/wd/hub') // 默认密码：secret
      .build();
    try {
      await driver.get('https://dhcjgl.o-learn.cn/');
      // 点击显示二维码
      await driver.wait(webdriver.until.elementLocated(By.css('.extra>button')), 10000).click();
      // 进入iframe
      ctx.logger.info('进入iframe');
      const iframe = await driver.wait(webdriver.until.elementLocated(By.css('iframe')), 10000);
      await driver.switchTo().frame(iframe);
      driver.sleep(3000);
      // 获取路径
      ctx.logger.info('获取路径');
      const qrcodePath = await driver.wait(webdriver.until.elementLocated(By.css('.wrp_code>img')), 10000).getAttribute('src');
      const render = ctx.render('home.html', { qrcodePath, uuid });
      // 退出iframe
      driver.switchTo().defaultContent();
      // 获取token
      this.getToken(driver, By, uuid);
      return render;
    } catch (error) {
      ctx.logger.error(error);
      ctx.logger.error('启动失败');
      await driver.quit();
    }
  }
  async getToken(driver, By, uuid) {
    const { ctx } = this;
    // 获取用户信息
    let userInfo = {};
    let getNoWxTimer = '';
    let isquit = false;
    try {
      // 校验是否因为没有绑定微信而登陆失败
      getNoWxTimer = setInterval(async () => {
        const localUrl = await driver.getCurrentUrl();
        if (localUrl.includes('/home/wxBind')) {
          ctx.logger.error('未绑定的微信');
          clearInterval(getNoWxTimer);
          await ctx.service.donghuaUniversity.create({
            id: uuid,
            name: 'error',
            regNo: 'error' + uuid,
            status: 5
          });
          if (!isquit) {
            await driver.quit();
            isquit = true;
          }
        }
      }, 3000);
      // 登录成功
      await driver.wait(webdriver.until.elementLocated(By.css('.log-out')), 120000);
      ctx.logger.info('登录成功');
      // 清除绑定微信校验
      clearInterval(getNoWxTimer);
      // 获取student-access-token
      const studentAccessToken = (await driver.manage().getCookie('student-access-token')).value;
      await axios({
        url: 'https://dhcjgl.o-learn.cn/ws/student/personal/studentPersonal/queryPersonalInfoData',
        method: 'post',
        headers: {
          Authorization: `Bearer ${studentAccessToken}`
        }
      }).then(async ({ data }) => {
        if (data.responseCode === 'SUCCESS') {
          userInfo = data.infoData;
          userInfo.id = uuid;
          // 计算内存
          const freememPercentage = os.freemem() / os.totalmem();
          ctx.logger.info(`内存剩余：${Math.floor(freememPercentage * 10000) / 100}%`);
          if (freememPercentage < 0.15) {
            ctx.logger.error('内存过载');
            userInfo.status = 99;
          } else {
            userInfo.status = 0;
          }
          // 更新信息，并且校验是否正在刷课
          const isInclassFlag = await ctx.service.donghuaUniversity.create(userInfo);
          if (!isInclassFlag) {
            // 正在刷课不继续走下去
            ctx.logger.info(`${userInfo.regNo}${userInfo.name}:正在刷课！`);
            // 发送邮件通知
            if (userInfo.email) {
              await ctx.service.tools.sendMail(
                userInfo.email,
                '刷课提醒',
                `
                  <p>${userInfo.name}你好！刷课任务已开始。</p>
                  <a href="https://donghua.right-house.love/class/getProgressView?q=${userInfo.id}">进度查询</a>
                  <p>QQ交流群：628240710</p>
                `
              );
            }
            return;
          }
          // 邮件提醒管理员
          await ctx.service.tools.sendMail(
            '452356248@qq.com',
            '新加入刷课',
            `
              <p>${userInfo.name}开始刷课</p>
            `
          );
          // 内存过载
          if (userInfo.status === 99) {
            if (!isquit) {
              await driver.quit();
              isquit = true;
            }
            return;
          }
          await this.getClassList(driver, By, userInfo, studentAccessToken);
        } else {
          ctx.logger.error('获取用户信息失败');
          if (!isquit) {
            await driver.quit();
            isquit = true;
          }
        }
      });
    } catch (error) {
      // 清除绑定微信校验
      clearInterval(getNoWxTimer);
      ctx.logger.error('登录失败');
      ctx.logger.error(error);
      if (!isquit) {
        await driver.quit();
        isquit = true;
      }
    }
  }
  async getClassList(driver, By, userInfo, studentAccessToken) {
    const { ctx } = this;
    try {
      // 获取课程列表
      await axios({
        url: 'https://dhcjgl.o-learn.cn/ws/student/learn/studentLearningCourse/queryLearningCourseData',
        method: 'post',
        headers: {
          Authorization: `Bearer ${studentAccessToken}`
        }
      }).then(async ({ data }) => {
        if (data.responseCode === 'SUCCESS') {
          ctx.logger.info(`${userInfo.regNo}${userInfo.name}:查询成功课程列表成功`);
          // 处理数据
          const allClassUrl = (data.courseList || [])
          // 过滤没有发布课程的
            .filter(item => !item.flagFixedCourse && item.flagLearningPlatform)
          // 组合url
            .map(item => {
              return `https://dhcjgl.o-learn.cn${item.learningUrl}&access_token=${studentAccessToken}`;
            });
          ctx.logger.info(`${userInfo.regNo}${userInfo.name}:可学习的课程地址`);
          ctx.logger.info(allClassUrl);
          if (allClassUrl && allClassUrl.length > 0) {
            // 打开页面 获取上课信息
            await this.openPage(0, allClassUrl, driver, By, 0, 1, [], 0, userInfo);
          } else {
            // 发送邮件通知
            if (userInfo.email) {
              await ctx.service.tools.sendMail(
                userInfo.email,
                '刷课提醒',
                `
                <p>${userInfo.name}你好！</p>
                <p>未查询到上课信息，课程可能暂未发布。详情请前往学习平台确认。</p>
                <p>QQ交流群：628240710</p>
              `
              );
            }
          }
        } else {
          ctx.logger.error(`${userInfo.regNo}${userInfo.name}:查询课程列表失败：${data.message}`);
          await driver.quit();
          // 设置刷课状态
          await ctx.service.donghuaUniversity.setInClass({
            regNo: userInfo.regNo,
            errorLog: data.message.toString(),
            status: 3
          });
          // 发送邮件通知
          if (userInfo.email) {
            await ctx.service.tools.sendMail(
              userInfo.email,
              '刷课提醒',
              `
                <p>${userInfo.name}你好！</p>
                <p>刷课任务出现错误，请重新登录重试，或联系管理员！</p>
                <p>错误信息：${data.message.toString()}</p>
                <p>QQ交流群：628240710</p>
              `
            );
          }
        }
      }).catch(async error => {
        ctx.logger.error(`${userInfo.regNo}${userInfo.name}:查询课程列表失败：错误信息`);
        ctx.logger.error(error);
        await driver.quit();
        // 设置刷课状态
        await ctx.service.donghuaUniversity.setInClass({
          regNo: userInfo.regNo,
          errorLog: error.toString(),
          status: 3
        });
        // 发送邮件通知
        if (userInfo.email) {
          await ctx.service.tools.sendMail(
            userInfo.email,
            '刷课提醒',
            `
              <p>${userInfo.name}你好！</p>
              <p>刷课任务出现错误，请重新登录重试，或联系管理员！</p>
              <p>错误信息：${error.toString()}</p>
              <p>QQ交流群：628240710</p>
            `
          );
        }
      });
    } catch (error) {
      ctx.logger.error(`${userInfo.regNo}${userInfo.name}:查询课程出错`);
      ctx.logger.error(error);
      await driver.quit();
      // 设置刷课状态
      await ctx.service.donghuaUniversity.setInClass({
        regNo: userInfo.regNo,
        errorLog: error.toString(),
        status: 3
      });
      // 发送邮件通知
      if (userInfo.email) {
        await ctx.service.tools.sendMail(
          userInfo.email,
          '刷课提醒',
          `
            <p>${userInfo.name}你好！</p>
            <p>刷课任务出现错误，请重新登录重试，或联系管理员！</p>
            <p>错误信息：${error.toString()}</p>
            <p>QQ交流群：628240710</p>
          `
        );
      }
    }
  }
  async openPage(
    classIndex,
    allClassUrl,
    driver,
    By,
    completeClassLengthData,
    continueClassLengthData,
    noStudyClassInfoData,
    classLengthData,
    userInfo
  ) {
    const { ctx } = this;
    try {

      // 已经学过
      let completeClassLength = completeClassLengthData;
      // 学习中
      const continueClassLength = continueClassLengthData;
      // 所有未学视频信息
      const noStudyClassInfo = noStudyClassInfoData;
      // 未学习的视频
      let classLength = classLengthData;
      // 打开课程地址
      ctx.logger.info(`${userInfo.regNo}${userInfo.name}:打开课程地址：${allClassUrl[classIndex]}`);
      await driver.get(allClassUrl[classIndex]);
      await driver.sleep(1000);
      // 获取url
      const url = await driver.getCurrentUrl();
      ctx.logger.info(`${userInfo.regNo}${userInfo.name}:跳转url为：${url}`);
      // 获取资源id参数
      let courseId = '';
      try {
        courseId = url.split('/').slice(-4, -3)[0];
      } catch (error) {
        await driver.quit();
        // 设置刷课状态
        await ctx.service.donghuaUniversity.setInClass({
          regNo: userInfo.regNo,
          errorLog: error.toString(),
          status: 3
        });
        // 发送邮件通知
        if (userInfo.email) {
          await ctx.service.tools.sendMail(
            userInfo.email,
            '刷课提醒',
            `
              <p>${userInfo.name}你好！</p>
              <p>刷课任务出现错误，请重新登录重试，或联系管理员！</p>
              <p>错误信息：${error.toString()}</p>
              <p>QQ交流群：628240710</p>
            `
          );
        }
        ctx.logger.error(`${userInfo.regNo}${userInfo.name}:未正常获取资源id`);
        ctx.logger.error(error);
      }
      ctx.logger.info(`${userInfo.regNo}${userInfo.name}:资源id为：${courseId}`);
      // 获取token
      const accessToken = (await driver.manage().getCookie('accessToken')).value;
      ctx.logger.info(`${userInfo.regNo}${userInfo.name}:学习平台cookie为：${accessToken}`);
      // 获取录播课列表
      const formData = new URLSearchParams();
      formData.append('courseId', courseId);
      await axios({
        url: 'https://www.learnin.com.cn/app/user/student/course/space/overview/appStudentCourseOverview/loadCourseOutlineData',
        method: 'post',
        headers: {
          Authorization: `Bearer ${accessToken}`
        },
        data: formData
      }).then(async ({ data }) => {
        if (data.errorCode === 0) {
          ctx.logger.info(`${userInfo.regNo}${userInfo.name}:录播课列表查询成功`);
          // 拆分已学习数据
          const videoCompleted = (data.learnRecords || []).filter(item => item.completeState === 'Completed').map(item => item.sectionContentId);
          // 拆分学习中数据
          // const videoContinue = (data.learnRecords || []).filter(item => item.completeState === 'Continue').map(item => item.sectionContentId);
          // 组合url
          (data.sectionContents || []).forEach(item => {
            if (item.additionTypeCode === 'VIDEO') {
              if (videoCompleted.includes(item.id)) {
                // 已经学过
                completeClassLength++;
              } else {
                // 未学习
                classLength++;
                item.classPath = `https://www.learnin.com.cn/user/#/user/student/course/${courseId}/learn/${item.id}?hideChapter=true`;
                noStudyClassInfo.push(item);
              }
              //  else if (videoContinue.includes(item.id)) {
              // // 学习中
              //   continueClassLength++;
              //   item.classPath = `https://www.learnin.com.cn/user/#/user/student/course/${courseId}/learn/${item.id}?hideChapter=true`;
              //   noStudyClassInfo.push(item);
              // }
            }
          });
        }
        // else {
        //   // 设置刷课状态
        //   await driver.quit();
        //   await ctx.service.donghuaUniversity.setInClass({
        //     regNo: userInfo.regNo,
        //     errorLog: data.message.toString(),
        //     status: 3
        //   });
        //   // 发送邮件通知
        //   if (userInfo.email) {
        //     await ctx.service.tools.sendMail(
        //       userInfo.email,
        //       '刷课提醒',
        //       `
        //         <p>${userInfo.name}你好！</p>
        //         <p>刷课任务出现错误，请重新登录重试，或联系管理员！</p>
        //         <p>错误信息：${data.message.toString()}</p>
        //         <p>QQ交流群：628240710</p>
        //       `
        //     );
        //   }
        //   ctx.logger.error(`${userInfo.regNo}${userInfo.name}:${data.message}`);
        // }
      }).catch(async error => {
        ctx.logger.error(`${userInfo.regNo}${userInfo.name}:录播课列表查询失败，错误信息：`);
        ctx.logger.error(error);
        await driver.quit();
        // 设置刷课状态
        await ctx.service.donghuaUniversity.setInClass({
          regNo: userInfo.regNo,
          errorLog: error.toString(),
          status: 3
        });
        // 发送邮件通知
        if (userInfo.email) {
          await ctx.service.tools.sendMail(
            userInfo.email,
            '刷课提醒',
            `
              <p>${userInfo.name}你好！</p>
              <p>刷课任务出现错误，请重新登录重试，或联系管理员！</p>
              <p>错误信息：${error.toString()}</p>
              <p>QQ交流群：628240710</p>
            `
          );
        }
      });

      // 循环调用所有课程
      if (classIndex < allClassUrl.length - 1) {
        await this.openPage(
          classIndex + 1,
          allClassUrl,
          driver,
          By,
          completeClassLength,
          continueClassLength,
          noStudyClassInfo,
          classLength,
          userInfo
        );
      } else {
      // 查询完毕更新数据
        const studentData = {
          regNo: userInfo.regNo,
          completeClass: completeClassLength,
          continueClass: continueClassLength,
          classLength
        };
        await ctx.service.donghuaUniversity.updateClassLength(studentData);
        // 开始上课
        await this.setClassGoOn(noStudyClassInfo, driver, By, studentData, userInfo);
        // 发送邮件通知
        if (userInfo.email && classLength > 0) {
          await ctx.service.tools.sendMail(
            userInfo.email,
            '刷课提醒',
            `
              <p>${userInfo.name}你好！刷课任务已开始，剩余课程数量：${classLength}</p>
              <a href="https://donghua.right-house.love/class/getProgressView?q=${userInfo.id}">进度查询</a>
              <p>QQ交流群：628240710</p>
            `
          );
        }
      }
    } catch (error) {
      ctx.logger.error(`${userInfo.regNo}${userInfo.name}:录播课列表查询出错`);
      ctx.logger.error(error);
      await driver.quit();
      // 设置刷课状态
      await ctx.service.donghuaUniversity.setInClass({
        regNo: userInfo.regNo,
        errorLog: error.toString(),
        status: 3
      });
      // 发送邮件通知
      if (userInfo.email) {
        await ctx.service.tools.sendMail(
          userInfo.email,
          '刷课提醒',
          `
            <p>${userInfo.name}你好！</p>
            <p>刷课任务出现错误，请重新登录重试，或联系管理员！</p>
            <p>错误信息：${error.toString()}</p>
            <p>QQ交流群：628240710</p>
          `
        );
      }
    }
  }
  async setClassGoOn(noStudyClassInfo, driver, By, studentData, userInfo) {
    const { ctx } = this;
    try {
      ctx.logger.info(`${userInfo.regNo}${userInfo.name}:剩余课程数量：${noStudyClassInfo.length}`);
      if (noStudyClassInfo.length === 0) {
        // 关闭chrome
        await driver.quit();
        // 设置刷课状态
        await ctx.service.donghuaUniversity.setInClass({
          regNo: userInfo.regNo,
          status: 2
        });
        ctx.logger.info(`${userInfo.regNo}${userInfo.name}:课程全部结束，停止巡查。`);
        // 发送邮件通知
        if (userInfo.email) {
          await ctx.service.tools.sendMail(
            userInfo.email,
            '刷课提醒',
            `
              ${userInfo.name}你好！刷课任务已完成，详情可前往学习平台查看。感谢使用！
              <p>QQ交流群：628240710</p>
            `
          );
        }
        return;
      }
      // 分割数据
      const currentClass = noStudyClassInfo.splice(0, 1)[0];
      ctx.logger.info(`${userInfo.regNo}${userInfo.name}:当前课程数据`);
      ctx.logger.info(currentClass);
      ctx.logger.info(`${userInfo.regNo}${userInfo.name}:打开地址`);
      await driver.executeScript(`window.open('${currentClass.classPath}','_blank');`);
      // 所有窗口handel
      const allWindowHandles = await driver.getAllWindowHandles();
      // 当前窗口handel
      const currentWindowHandle = allWindowHandles[allWindowHandles.length - 1];
      // 关闭其他窗口
      await driver.switchTo().window(allWindowHandles[0]);
      await driver.close();
      // 切换最新窗口
      await driver.switchTo().window(currentWindowHandle);
      ctx.logger.info(`${userInfo.regNo}${userInfo.name}:等待视频加载`);
      await driver.sleep(3000);
      // 等待视频出现
      await driver.wait(webdriver.until.elementLocated(By.css('#vjs_video_3_html5_api')), 10000);
      // 设置静音
      await driver.executeScript('document.querySelector("#vjs_video_3_html5_api").volume=0');
      // 设置自动循环播放
      await driver.executeScript('document.querySelector("#vjs_video_3_html5_api").setAttribute("loop","")');
      ctx.logger.info(`${userInfo.regNo}${userInfo.name}:开始播放`);
      await driver.wait(webdriver.until.elementLocated(By.css('.pv-controls-left>button')), 10000).click();
      // 点击二倍速
      ctx.logger.info(`${userInfo.regNo}${userInfo.name}:二倍速播放`);
      await driver.executeScript('document.querySelector(\'.pv-controls-right>div:first-child>div>div>div:nth-child(1)\').click()');
      ctx.logger.info('=======================================================================');
      // 设置刷课状态
      await ctx.service.donghuaUniversity.setInClass({
        regNo: userInfo.regNo,
        status: 1
      });
      // 运行巡查程序
      await this.inspectionClass(currentClass, driver, By, noStudyClassInfo, studentData, userInfo);
    } catch (error) {
      ctx.logger.error(`${userInfo.regNo}${userInfo.name}:上课程序运行出错`);
      ctx.logger.error(error);
      await driver.quit();
      // 设置刷课状态
      await ctx.service.donghuaUniversity.setInClass({
        regNo: userInfo.regNo,
        errorLog: error.toString(),
        status: 3
      });
      // 发送邮件通知
      if (userInfo.email) {
        await ctx.service.tools.sendMail(
          userInfo.email,
          '刷课提醒',
          `
            <p>${userInfo.name}你好！</p>
            <p>刷课任务出现错误，请重新登录重试，或联系管理员！</p>
            <p>错误信息：${error.toString()}</p>
            <p>QQ交流群：628240710</p>
          `
        );
      }
    }
  }
  async inspectionClass(currentClass, driver, By, noStudyClassInfo, studentData, userInfo) {
    const { ctx } = this;
    let timer = '';
    ctx.logger.info(`${userInfo.regNo}${userInfo.name}:课程：${currentClass.title}=》巡查程序运行中`);
    // 每分钟巡查一次
    timer = setInterval(async () => {
      try {
        ctx.logger.info(`${userInfo.regNo}${userInfo.name}:课程：${currentClass.title}=》开始巡查`);
        // 获取url
        const url = await driver.getCurrentUrl();
        ctx.logger.info(`${userInfo.regNo}${userInfo.name}:url为：${url}`);
        // 获取资源id参数
        let courseId = '';
        try {
          courseId = url.split('/').slice(-3, -2)[0];
        } catch (error) {
          ctx.logger.error('未正常获取资源id');
        }
        ctx.logger.info(`${userInfo.regNo}${userInfo.name}:资源id为：${courseId}`);
        // 获取token
        const accessToken = (await driver.manage().getCookie('accessToken')).value;
        // 获取录播课列表
        const formData = new URLSearchParams();
        formData.append('courseId', courseId);
        await axios({
          url: 'https://www.learnin.com.cn/app/user/student/course/space/overview/appStudentCourseOverview/loadCourseOutlineData',
          method: 'post',
          headers: {
            Authorization: `Bearer ${accessToken}`
          },
          data: formData
        }).then(async ({ data }) => {
          if (data.errorCode === 0) {
            const hasCurrentClass = (data.learnRecords || []).some(item => item.sectionContentId === currentClass.id);
            if (hasCurrentClass) {
              for (let i = 0; i < (data.learnRecords || []).length; i++) {
                const item = (data.learnRecords || [])[i];
                if (item.sectionContentId === currentClass.id) {
                // 当前数据
                  ctx.logger.info(`${userInfo.regNo}${userInfo.name}:查询数据成功`);
                  if (item.completeState === 'Completed') {
                  // 播放完成
                    ctx.logger.info(`${userInfo.regNo}${userInfo.name}:课程状态：播放完成`);
                    ctx.logger.info('=======================================================================');
                    clearInterval(timer);
                    // 更新数据
                    studentData.completeClass++;
                    studentData.classLength--;
                    if (noStudyClassInfo.length === 0) {
                      studentData.continueClass = 0;
                    } else {
                      studentData.continueClass = 1;
                    }
                    await ctx.service.donghuaUniversity.updateClassLength(studentData);
                    // 检测暂停状态
                    const studentStatus = await ctx.service.donghuaUniversity.getStatusByRegNo(userInfo.regNo);
                    if (studentStatus.status === 4) {
                      ctx.logger.info(`${userInfo.regNo}${userInfo.name}:检测到暂停状态，停止上课！`);
                      await driver.quit();
                    } else {
                    // 继续上课
                      await this.setClassGoOn(noStudyClassInfo, driver, By, studentData, userInfo);
                    }
                  } else {
                  // 未结束
                    ctx.logger.info(`${userInfo.regNo}${userInfo.name}:课程状态：进行中`);
                    ctx.logger.info('=======================================================================');
                  }
                  break;
                }
              }
            } else {
              const errorText = `${userInfo.regNo}${userInfo.name}:巡查程序出错，错误信息：无法获取课程：${currentClass.title}状态`;
              ctx.logger.error(errorText);
              ctx.logger.error(JSON.stringify(currentClass));
              ctx.logger.error(JSON.stringify((data.learnRecords || [])));
              clearInterval(timer);
              await driver.quit();
              // 设置刷课状态
              await ctx.service.donghuaUniversity.setInClass({
                regNo: userInfo.regNo,
                errorLog: errorText,
                status: 3
              });
              // 发送邮件通知
              if (userInfo.email) {
                await ctx.service.tools.sendMail(
                  userInfo.email,
                  '刷课提醒',
                  `
                  <p>${errorText}</p>
                  <p>QQ交流群：628240710</p>
                  `
                );
              }
            }
          } else {
            ctx.logger.error(`${userInfo.regNo}${userInfo.name}:刷课状态获取出错：${data.message}`);
          }
        }).catch(async error => {
          ctx.logger.error(`${userInfo.regNo}${userInfo.name}:课程服务器异常，错误信息：`);
          ctx.logger.error(error);
        });
      } catch (error) {
        ctx.logger.error(`${userInfo.regNo}${userInfo.name}:巡查程序出错，错误信息：`);
        ctx.logger.error(error);
        clearInterval(timer);
        await driver.quit();
        // 设置刷课状态
        await ctx.service.donghuaUniversity.setInClass({
          regNo: userInfo.regNo,
          errorLog: error.toString(),
          status: 3
        });
        // 发送邮件通知
        if (userInfo.email) {
          await ctx.service.tools.sendMail(
            userInfo.email,
            '刷课提醒',
            `
              <p>${userInfo.name}你好！</p>
              <p>刷课任务出现错误，请重新登录重试，或联系管理员！</p>
              <p>错误信息：${error.toString()}</p>
              <p>QQ交流群：628240710</p>
            `
          );
        }
      }
    }, 60000);
  }
}

module.exports = HomeController;
